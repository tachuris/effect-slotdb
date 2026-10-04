import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { SqliteClient } from '@effect/sql-sqlite-bun'
import { SqlClient } from 'effect/sql'

// Wait briefly for concurrent writers instead of failing immediately with SQLITE_BUSY.
// The Bun client enables WAL without setting busy_timeout.
const setBusyTimeout = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      PRAGMA busy_timeout = 5000
    `
  }),
)

/**
 * Advances whenever another connection commits to the same database file. Lets a
 * read-only process detect external writes.
 */
export const dataVersion = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ dataVersion?: number }>`
    PRAGMA data_version
  `
  return rows[0].dataVersion ?? 0
})

/**
 * Sqlite client layer for the given database file.
 * The caller decides where the file lives.
 */
export const SqliteClientBun = (filename: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* Effect.sync(() => mkdirSync(dirname(filename), { recursive: true }))
      return setBusyTimeout.pipe(Layer.provideMerge(SqliteClient.layer({ filename })))
    }),
  )
