import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import { type EntityEntry, type SchemaIndex } from '@tachuris/effect-slotdb/migration'
import { type ColumnSpec, columnSpecs, keyIndexOf, uniqueIndexOf } from './ddl.ts'
import { mapStorageErrorMessage, StorageError } from '@tachuris/effect-slotdb'

/**
 * Checks stored columns and indexes against the migration chain before row operations
 * run.
 */

/**
 * A table's shape compared against what the chain derives: missing, extra, or differing
 * columns and indexes.
 */
export interface SchemaMismatch {
  readonly table: string
  readonly missing: ReadonlyArray<string>
  readonly unaccounted: ReadonlyArray<string>
  /**
   * Columns present under the right name with the wrong shape, as `expected` against
   * `found`.
   */
  readonly differing: ReadonlyArray<{
    readonly column: string
    readonly expected: string
    readonly found: string
  }>
  readonly indexes: ReadonlyArray<string>
}

const ColumnRow = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  notnull: Schema.Number,
  dflt_value: Schema.NullOr(Schema.String),
  pk: Schema.Number,
})
const decodeColumns = Schema.decodeUnknownSync(Schema.Array(ColumnRow))

const IndexRow = Schema.Struct({ name: Schema.String, unique: Schema.Number })
const decodeIndexes = Schema.decodeUnknownSync(Schema.Array(IndexRow))

const IndexColumnRow = Schema.Struct({ seqno: Schema.Number, name: Schema.String })
const decodeIndexColumns = Schema.decodeUnknownSync(Schema.Array(IndexColumnRow))

/**
 * A column rendered the same way from either side, so a difference reads as one line of
 * text.
 */
const describeColumn = (spec: {
  readonly type: string
  readonly notNull: boolean
  readonly primaryKey: boolean
  readonly defaultLiteral?: string
}): string =>
  [
    spec.type,
    spec.primaryKey ? 'PRIMARY KEY' : undefined,
    spec.notNull ? 'NOT NULL' : 'NULL',
    spec.defaultLiteral === undefined ? undefined : `DEFAULT ${spec.defaultLiteral}`,
  ]
    .filter(part => part !== undefined)
    .join(' ')

/** Compare one table's actual columns against the specs the derivation expects. */
export const compareColumns = (
  table: string,
  expected: ReadonlyArray<ColumnSpec>,
  actual: ReadonlyArray<typeof ColumnRow.Type>,
): Omit<SchemaMismatch, 'indexes'> => {
  const found = new Map(actual.map(row => [row.name, row]))
  const wanted = new Set(expected.map(spec => spec.name))

  const missing: string[] = []
  const differing: Array<{ column: string; expected: string; found: string }> = []

  for (const spec of expected) {
    const row = found.get(spec.name)
    if (row === undefined) {
      missing.push(spec.name)
      continue
    }
    // Compare declared SQLite type names directly with the stored column declarations.
    const shape = describeColumn({
      type: row.type,
      notNull: row.notnull === 1,
      primaryKey: row.pk > 0,
      defaultLiteral: row.dflt_value ?? undefined,
    })
    const want = describeColumn(spec)
    if (shape !== want) differing.push({ column: spec.name, expected: want, found: shape })
  }

  return {
    table,
    missing,
    unaccounted: actual.filter(row => !wanted.has(row.name)).map(row => row.name),
    differing,
  }
}

/** Renders a mismatch as the multi-line report the boot-time failure message includes. */
export const describeMismatch = (mismatch: SchemaMismatch): string =>
  [
    `table '${mismatch.table}' does not match the schema derived from the chain.`,
    mismatch.missing.length > 0 ? `  missing: ${mismatch.missing.join(', ')}` : undefined,
    mismatch.unaccounted.length > 0
      ? `  present but not derived: ${mismatch.unaccounted.join(', ')}`
      : undefined,
    ...mismatch.differing.map(d => `  ${d.column}: expected ${d.expected}, found ${d.found}`),
    ...mismatch.indexes.map(line => `  ${line}`),
  ]
    .filter(line => line !== undefined)
    .join('\n')

/** Controls whether schema checks accept extra columns recorded by newer migrations. */
export interface GuardOptions {
  /**
   * Whether recorded migration history includes files beyond this build's chain. Permits
   * extra columns declared by those migrations.
   */
  readonly databaseIsAhead?: boolean
}

const isEmpty = (mismatch: SchemaMismatch, options: GuardOptions): boolean =>
  mismatch.missing.length === 0 &&
  (options.databaseIsAhead === true || mismatch.unaccounted.length === 0) &&
  mismatch.differing.length === 0 &&
  mismatch.indexes.length === 0

/**
 * Whether the natural-key index exists, is unique, and covers the right columns in order.
 */
const checkKeyIndex = (sql: SqlClient.SqlClient, entity: EntityEntry) =>
  Effect.gen(function* () {
    const expected = keyIndexOf(entity)
    if (expected === undefined) return []

    const listed = yield* listedIndex(sql, entity.table, expected.name)
    if (listed === undefined) return [`missing unique index ${expected.name}`]
    if (listed.unique !== 1) return [`index ${expected.name} is not unique`]

    // Index column order must match the natural key order used to derive row IDs.
    return yield* compareIndexColumns(sql, expected)
  })

/**
 * Checks that the unique tuple index exists, is nonunique, and has the declared columns
 * in order. A unique index would reject duplicate tuples from other peers.
 */
const checkUniqueIndex = (sql: SqlClient.SqlClient, entity: EntityEntry) =>
  Effect.gen(function* () {
    const expected = uniqueIndexOf(entity)
    if (expected === undefined) return []

    const listed = yield* listedIndex(sql, entity.table, expected.name)
    if (listed === undefined) return [`missing index ${expected.name}`]
    if (listed.unique !== 0) {
      return [
        `index ${expected.name} is unique, and a unique index over replicated rows stops sync ` +
          `the first time two peers create a row holding the same values`,
      ]
    }

    return yield* compareIndexColumns(sql, expected)
  })

/**
 * One index of a table as `pragma_index_list` reports it, or undefined when it is absent.
 */
const listedIndex = (sql: SqlClient.SqlClient, table: string, name: string) =>
  Effect.gen(function* () {
    const listed = decodeIndexes(
      yield* sql`
  SELECT
    name,
    "unique"
  FROM
    pragma_index_list (${table})
`,
    )
    return listed.find(row => row.name === name)
  })

/**
 * The columns an index actually covers, against the ones it should, as at most one line.
 */
const compareIndexColumns = (
  sql: SqlClient.SqlClient,
  expected: { readonly name: string; readonly columns: ReadonlyArray<string> },
) =>
  Effect.gen(function* () {
    const indexed = decodeIndexColumns(
      yield* sql`
  SELECT
    seqno,
    name
  FROM
    pragma_index_info (${expected.name})
`,
    )
    const columns = [...indexed].sort((a, b) => a.seqno - b.seqno).map(row => row.name)

    const want = expected.columns.join(', ')
    return columns.join(', ') === want
      ? []
      : [`index ${expected.name} covers (${columns.join(', ')}), expected (${want})`]
  })

/** Compares all managed tables and indexes with the derived schema. */
export const checkDatabase = (
  index: SchemaIndex,
  options: GuardOptions = {},
): Effect.Effect<ReadonlyArray<SchemaMismatch>, StorageError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const mismatches: SchemaMismatch[] = []

    for (const entity of index.entities.values()) {
      const actual = decodeColumns(
        yield* sql`
  SELECT
    name,
    type,
    "notnull",
    dflt_value,
    pk
  FROM
    pragma_table_info (${entity.table})
`,
      )

      // Report all missing columns for an absent table and omit redundant index failures.
      const columns = compareColumns(entity.table, columnSpecs(entity), actual)
      const indexes =
        actual.length === 0
          ? []
          : [...(yield* checkKeyIndex(sql, entity)), ...(yield* checkUniqueIndex(sql, entity))]

      const mismatch = { ...columns, indexes }
      if (!isEmpty(mismatch, options)) mismatches.push(mismatch)
    }

    return mismatches
  }).pipe(mapStorageErrorMessage('Failed to inspect the database schema'))

/** Checks the stored schema and fails with all reported mismatches. */
export const assertDatabaseMatches = (
  index: SchemaIndex,
  options: GuardOptions = {},
): Effect.Effect<void, StorageError, SqlClient.SqlClient> =>
  checkDatabase(index, options).pipe(
    Effect.flatMap(mismatches =>
      mismatches.length === 0
        ? Effect.void
        : Effect.fail(
            new StorageError({
              message: `Database schema does not match the migration chain.\n${mismatches
                .map(describeMismatch)
                .join('\n')}`,
            }),
          ),
    ),
  )
