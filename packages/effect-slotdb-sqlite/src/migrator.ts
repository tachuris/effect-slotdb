import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { Migrator, SqlClient, type SqlError } from 'effect/sql'
import { drainOverflow, type SchemaIndex } from '@tachuris/effect-slotdb/migration'
import { type DerivedMigration, deriveMigrations } from './ddl.ts'
import { assertDatabaseMatches } from './guard.ts'
import { mapStorageErrorMessage, StorageError } from '@tachuris/effect-slotdb'

/**
 * Builds and checks a SQLite store from a migration chain.
 * @module
 */

/** The migration history table name. */
const MIGRATIONS_TABLE = 'effect_sql_migrations'

/**
 * Checks migration history, applies migrations, checks the schema, and drains overflow.
 * Runs the drain on every startup to recover values received during a downgrade. Returns
 * the number of drained values.
 */
export const migrate = (
  index: SchemaIndex,
): Effect.Effect<number, StorageError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const derived = deriveMigrations(index.chain)
    const { databaseIsAhead } = yield* inspectHistory(derived)

    yield* Migrator.make({})({
      table: MIGRATIONS_TABLE,
      loader: Migrator.fromRecord(
        Object.fromEntries(
          derived.map(migration => [keyOf(migration), runStatements(migration.statements)]),
        ),
      ),
    })

    yield* assertDatabaseMatches(index, { databaseIsAhead })

    const sql = yield* SqlClient.SqlClient
    return yield* drainOverflow(sql, index)
  }).pipe(mapStorageErrorMessage('Failed to migrate the store'))

/** Returns a loader key in the `<id>_<name>` format with IDs starting at one. */
const keyOf = (migration: DerivedMigration): string =>
  `${String(migration.id).padStart(4, '0')}_${migration.name}`

const runStatements = (
  statements: ReadonlyArray<string>,
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.forEach(statements, statement => sql.unsafe(statement), { discard: true })
  })

const MigrationRow = Schema.Struct({ migration_id: Schema.Number, name: Schema.String })
const decodeRows = Schema.decodeUnknownSync(Schema.Array(MigrationRow))

/** Reads recorded migration IDs and names. Returns an empty list for a new store. */
const readHistory = (
  sql: SqlClient.SqlClient,
): Effect.Effect<ReadonlyArray<typeof MigrationRow.Type>, unknown, never> =>
  Effect.gen(function* () {
    const present = yield* sql`
      SELECT
        name
      FROM
        sqlite_master
      WHERE
        type = 'table'
        AND name = ${MIGRATIONS_TABLE}
    `
    if (present.length === 0) return []

    return decodeRows(
      yield* sql`
        SELECT
          migration_id,
          name
        FROM
          ${sql(MIGRATIONS_TABLE)}
      `,
    )
  })

/**
 * Returns the first migration conflict in the shared chain prefix. Accepts recorded
 * migrations beyond this build's prefix.
 */
const divergence = (
  recorded: ReadonlyArray<typeof MigrationRow.Type>,
  derived: ReadonlyArray<DerivedMigration>,
): { readonly id: number; readonly expected: string; readonly found: string } | undefined => {
  const byId = new Map(derived.map(migration => [migration.id, migration.name]))
  for (const row of recorded) {
    const expected = byId.get(row.migration_id)
    if (expected !== undefined && expected !== row.name) {
      return { id: row.migration_id, expected, found: row.name }
    }
  }
  return undefined
}

/**
 * Checks migration history before applying migrations. Accepts newer chain prefixes and
 * rejects conflicting shared migrations.
 */
const inspectHistory = (
  derived: ReadonlyArray<DerivedMigration>,
): Effect.Effect<{ readonly databaseIsAhead: boolean }, StorageError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const recorded = yield* readHistory(sql)

    const conflict = divergence(recorded, derived)
    if (conflict !== undefined) {
      return yield* Effect.fail(
        new StorageError({
          message:
            `Migration ${conflict.id} is recorded as '${conflict.found}', but this build expects ` +
            `'${conflict.expected}'. The migration histories conflict. Use the matching ` +
            `migration chain or recreate the store.`,
        }),
      )
    }

    const lastDerivedId = derived.length
    return { databaseIsAhead: recorded.some(row => row.migration_id > lastDerivedId) }
  }).pipe(mapStorageErrorMessage('Failed to read the migration history'))
