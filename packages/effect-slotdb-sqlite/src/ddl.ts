import * as SchemaAST from 'effect/SchemaAST'
import {
  deriveIndex,
  type EntityEntry,
  type FieldEntry,
  type Migration,
  type SchemaIndex,
  sideTableDdl,
} from '@tachuris/effect-slotdb/migration'

/**
 * Derives SQLite tables, columns, and indexes from a migration chain. Renames preserve
 * stored names and removed fields retain their columns.
 */

// --- Column types ---

const NULL_TAGS = new Set(['Null', 'Undefined'])

/** Maps a field's encoded type to a SQLite affinity. Unknown encoded types use TEXT. */
const columnType = (field: FieldEntry): { readonly type: string; readonly nullable: boolean } => {
  const encoded = SchemaAST.toEncoded(field.schema.ast) as any
  const members: ReadonlyArray<any> = Array.isArray(encoded.types) ? encoded.types : [encoded]

  const nullable = members.some(m => NULL_TAGS.has(String(m._tag)))
  const present = members.filter(m => !NULL_TAGS.has(String(m._tag)))

  const numeric = present.length > 0 && present.every(m => isNumeric(m))
  return { type: numeric ? 'INTEGER' : 'TEXT', nullable }
}

const isNumeric = (ast: any): boolean => {
  const tag = String(ast._tag)
  if (tag === 'Number') return true
  if (tag === 'Boolean') return true
  // Inspect literal values to distinguish encoded booleans from string enums.
  if (tag === 'Literal') return typeof ast.literal === 'number' || typeof ast.literal === 'boolean'
  return false
}

/** A derived column specification comparable with `pragma_table_info` results. */
export interface ColumnSpec {
  readonly name: string
  readonly type: 'TEXT' | 'INTEGER'
  readonly notNull: boolean
  /**
   * The default SQL literal, matching `dflt_value`, or undefined without a default.
   */
  readonly defaultLiteral?: string
  readonly primaryKey: boolean
}

/**
 * A stored value rendered as a SQL literal, or undefined when the field declares no
 * default.
 */
const defaultLiteralOf = (field: FieldEntry): string | undefined => {
  const value = field.columnDefault
  // Nullable columns default to NULL without an explicit default.
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  throw new Error(
    `schema ddl: '${field.birthName}' declares a default of type ${typeof value}, which has no SQL literal`,
  )
}

/**
 * The nonnullable row ID column. Explicit `NOT NULL` prevents null IDs that replication
 * queries cannot address.
 */
const ROW_ID: ColumnSpec = { name: '__rowId', type: 'TEXT', notNull: true, primaryKey: true }

/**
 * Leaves a column with a `decodeFromOld` fallback nullable and without a default, so NULL
 * marks an unwritten slot. Reads then apply the fallback, then the field default.
 */
const specOf = (field: FieldEntry): ColumnSpec => {
  const { type, nullable } = columnType(field)
  const hasFallback = field.fallbackDecode !== undefined
  return {
    name: field.column,
    type: type as ColumnSpec['type'],
    notNull: !nullable && !hasFallback,
    defaultLiteral: hasFallback ? undefined : defaultLiteralOf(field),
    primaryKey: false,
  }
}

const renderColumn = (spec: ColumnSpec): string =>
  [
    spec.name,
    spec.type,
    spec.primaryKey ? 'PRIMARY KEY' : undefined,
    spec.notNull ? 'NOT NULL' : undefined,
    spec.defaultLiteral === undefined ? undefined : `DEFAULT ${spec.defaultLiteral}`,
  ]
    .filter(part => part !== undefined)
    .join(' ')

// --- Tables ---

/** Returns all stored columns with the row ID first and other columns sorted by name. */
export const columnSpecs = (entity: EntityEntry): ReadonlyArray<ColumnSpec> => [
  // A derived row ID makes independently created rows with the same key converge.
  ROW_ID,
  ...entity.columnFields.map(specOf),
]

/**
 * The unique index over an entity's natural key, absent when the entity declares none.
 */
export const keyIndexOf = (
  entity: EntityEntry,
): { readonly name: string; readonly columns: ReadonlyArray<string> } | undefined => {
  const columns = entity.keyColumns
  return columns.length === 0 ? undefined : { name: `idx_${entity.table}_key`, columns }
}

/**
 * The lookup index over an entity's unique tuple, absent when the entity declares none.
 */
export const uniqueIndexOf = (
  entity: EntityEntry,
): { readonly name: string; readonly columns: ReadonlyArray<string> } | undefined => {
  const columns = entity.uniqueColumns
  return columns.length === 0 ? undefined : { name: `idx_${entity.table}_unique`, columns }
}

/** Returns a table declaration with stored columns, including retired fields. */
export const createTable = (entity: EntityEntry): string =>
  `CREATE TABLE ${entity.table} (\n${columnSpecs(entity)
    .map(spec => `  ${renderColumn(spec)}`)
    .join(',\n')}\n)`

/**
 * Returns a `CREATE UNIQUE INDEX` statement for the natural key, or an empty array
 * when the entity has no natural key.
 */
export const createKeyIndex = (entity: EntityEntry): ReadonlyArray<string> => {
  const index = keyIndexOf(entity)
  if (index === undefined) return []
  return [`CREATE UNIQUE INDEX ${index.name} ON ${entity.table} (${index.columns.join(', ')})`]
}

/**
 * Returns a nonunique lookup index for the unique tuple. Replication permits duplicate
 * tuples, so a unique index would reject valid incoming rows.
 */
export const createUniqueIndex = (entity: EntityEntry): ReadonlyArray<string> => {
  const index = uniqueIndexOf(entity)
  if (index === undefined) return []
  return [`CREATE INDEX ${index.name} ON ${entity.table} (${index.columns.join(', ')})`]
}

/**
 * Adds a stored column to an existing table. Rejects nonnullable columns without defaults
 * because existing rows need a value.
 */
export const addColumn = (entity: EntityEntry, field: FieldEntry): string => {
  if (!columnType(field).nullable && defaultLiteralOf(field) === undefined) {
    throw new Error(
      `schema ddl: '${entity.table}.${field.column}' requires a default because the column ` +
        `is nonnullable and the table already exists. Use \`withDefault\` or make the field nullable.`,
    )
  }
  return `ALTER TABLE ${entity.table} ADD COLUMN ${renderColumn(specOf(field))}`
}

// --- DDL derivation ---

/** Derived statements for one migration file. */
export interface DerivedMigration {
  /** The migration ID, starting at one because the loader skips IDs at or below zero. */
  readonly id: number
  readonly name: string
  readonly statements: ReadonlyArray<string>
}

/**
 * Derives one migration per chain file, adding tables, columns, and indexes as needed.
 * Custom statements run after the file's derived DDL.
 */
export const deriveMigrations = (chain: readonly Migration[]): ReadonlyArray<DerivedMigration> =>
  chain.map((migration, i) => {
    const before = deriveIndex(chain.slice(0, i))
    const after = deriveIndex(chain.slice(0, i + 1))

    const created: string[] = []
    const added: string[] = []

    const entities = [...after.entities.values()].sort((a, b) => (a.table < b.table ? -1 : 1))
    for (const entity of entities) {
      const previous = before.entities.get(entity.id)
      if (previous === undefined) {
        created.push(createTable(entity), ...createKeyIndex(entity), ...createUniqueIndex(entity))
        continue
      }
      requireFilledRetiredColumns(entity)
      for (const field of entity.columnFields) {
        if (previous.fieldsById.has(field.id)) {
          continue
        }
        added.push(addColumn(entity, field))
      }
      // Create the tuple index when a migration adds unique fields to an existing table.
      if (uniqueIndexOf(previous) === undefined) {
        added.push(...createUniqueIndex(entity))
      }
    }

    return {
      id: i + 1,
      name: migration.name ?? migration.file,
      statements: [
        // Create metadata tables before entity writes can create stamps.
        ...(i === 0 ? sideTableDdl() : []),
        ...created,
        ...added,
        ...(migration.sql ?? []),
      ],
    }
  })

/**
 * Rejects retired NOT NULL columns without defaults unless a live field fills those
 * columns through `encodeToOld`. SQLite retains the constraints on retired columns.
 */
const requireFilledRetiredColumns = (entity: EntityEntry): void => {
  for (const id of entity.retiredFields) {
    const retired = entity.fieldsById.get(id)!
    const spec = specOf(retired)
    if (!spec.notNull || spec.defaultLiteral !== undefined) continue
    if (filledByLiveField(entity, id)) continue
    throw new Error(
      `schema ddl: retiring '${entity.table}.${retired.column}' leaves a NOT NULL column ` +
        `without a default or a live field that fills the column. Retype with \`encodeToOld\`, ` +
        `declare a source default with \`withDefault\`, or make the source nullable.`,
    )
  }
}

/** Checks whether a live field fills slot `id` through an `encodeToOld` chain. */
const filledByLiveField = (entity: EntityEntry, id: FieldEntry['id']): boolean =>
  [...entity.fieldsById.values()].some(
    field =>
      field.fallbackEncode !== undefined &&
      field.supersedes?.includes(id) === true &&
      (field.currentName !== undefined || filledByLiveField(entity, field.id)),
  )

/**
 * Returns all statements for creating a fresh database, in migration order.
 */
export const deriveDdl = (chain: readonly Migration[]): ReadonlyArray<string> =>
  deriveMigrations(chain).flatMap(m => m.statements)

/** Returns derived table names for the startup schema check. */
export const managedTables = (index: SchemaIndex): ReadonlyArray<string> =>
  [...index.entities.values()].map(e => e.table).sort()
