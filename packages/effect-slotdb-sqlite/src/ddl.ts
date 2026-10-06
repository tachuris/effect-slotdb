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

// --- column types ----------------------------------------------------------

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
   * The SQL literal as it appears in the DDL, matching `dflt_value`, absent when there is
   * none.
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

const specOf = (field: FieldEntry): ColumnSpec => {
  const { type, nullable } = columnType(field)
  return {
    name: field.column,
    type: type as ColumnSpec['type'],
    notNull: !nullable,
    defaultLiteral: defaultLiteralOf(field),
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

// --- tables ----------------------------------------------------------------

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
 * The `CREATE UNIQUE INDEX` statement over an entity's natural key, absent when it
 * declares none.
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
  const spec = specOf(field)
  if (spec.notNull && spec.defaultLiteral === undefined) {
    throw new Error(
      `schema ddl: '${entity.table}.${field.column}' is added to an existing table and is not ` +
        `nullable, so it needs a default. Declare one with \`withDefault\`, or make the field nullable.`,
    )
  }
  return `ALTER TABLE ${entity.table} ADD COLUMN ${renderColumn(spec)}`
}

// --- the derivation --------------------------------------------------------

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
      for (const id of entity.retiredFields) {
        if (previous.retiredFields.has(id)) continue
        const source = previous.fieldsById.get(id)
        if (source === undefined) continue
        const spec = specOf(source)
        if (spec.notNull && spec.defaultLiteral === undefined) {
          throw new Error(
            `schema ddl: retiring '${entity.table}.${source.column}' leaves a NOT NULL column ` +
              `without a default. Declare a source column default with \`withDefault\` before ` +
              `retiring the field, or make the source nullable. A replacement default does not fill the source column.`,
          )
        }
      }
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
 * Every statement a chain produces, in migration order.
 * The whole schema, for a fresh database.
 */
export const deriveDdl = (chain: readonly Migration[]): ReadonlyArray<string> =>
  deriveMigrations(chain).flatMap(m => m.statements)

/** The tables the derivation owns, which the boot guard is entitled to check. */
export const managedTables = (index: SchemaIndex): ReadonlyArray<string> =>
  [...index.entities.values()].map(e => e.table).sort()
