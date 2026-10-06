import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { SqlClient } from 'effect/sql'
import { migrate } from './migrator.ts'
import { FIXTURE_INDEX, makeInMemorySqliteLayer } from './testing.ts'

/**
 * A migrations table defined independently of derivation to represent an existing store.
 */
const MIGRATIONS_TABLE = `CREATE TABLE effect_sql_migrations (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
)`

const run = migrate(FIXTURE_INDEX)

const bootOver = (setup: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of setup) yield* sql.unsafe(statement)
    return yield* Effect.result(run)
  }).pipe(Effect.provide(makeInMemorySqliteLayer()))

describe('migrating a store from a chain', () => {
  it.effect('builds a fresh store', () =>
    Effect.gen(function* () {
      expect((yield* bootOver([]))._tag).toBe('Success')
    }),
  )

  it.effect('records one migration per chain file using the declared name', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* run
      const rows = yield* sql`
        SELECT
          migration_id,
          name
        FROM
          effect_sql_migrations
        ORDER BY
          migration_id
      `
      // Start migration IDs at one because a fresh store skips IDs at or below zero.
      expect(rows).toEqual([
        { migration_id: 1, name: 'support' },
        { migration_id: 2, name: 'domain' },
        { migration_id: 3, name: 'later' },
        { migration_id: 4, name: 'retype' },
        { migration_id: 5, name: 'retype' },
        { migration_id: 6, name: 'wrapped-local' },
        { migration_id: 7, name: 'all-key' },
        { migration_id: 8, name: 'unique' },
        { migration_id: 9, name: 'open' },
      ])
    }).pipe(Effect.provide(makeInMemorySqliteLayer())),
  )

  it.effect('rejects conflicting migration history in the shared chain prefix', () =>
    Effect.gen(function* () {
      // Reject conflicting history before the migrator skips recorded IDs.
      const outcome = yield* bootOver([
        MIGRATIONS_TABLE,
        `INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'something_else')`,
      ])

      expect(outcome._tag).toBe('Failure')
      if (outcome._tag === 'Failure') {
        expect(String(outcome.failure)).toContain('something_else')
        expect(String(outcome.failure)).toContain('support')
      }
    }),
  )

  it.effect('completes the chain for a store with an existing history table', () =>
    Effect.gen(function* () {
      // An existing history table may have no applied migrations.
      expect((yield* bootOver([MIGRATIONS_TABLE]))._tag).toBe('Success')
    }),
  )

  it.effect('starts with a store created by a newer build', () =>
    Effect.gen(function* () {
      // Accept columns declared by newer migrations so older builds can start and drain
      // overflow.
      const sql = yield* SqlClient.SqlClient
      const outcome = yield* Effect.result(
        Effect.gen(function* () {
          yield* run
          yield* sql.unsafe(`ALTER TABLE notes ADD COLUMN inventedLater TEXT`)
          yield* sql.unsafe(
            `INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'from_the_future')`,
          )
          // Start the older build again against the same store.
          yield* run
        }),
      )

      expect(outcome._tag).toBe('Success')
    }).pipe(Effect.provide(makeInMemorySqliteLayer())),
  )

  it.effect('rejects a column absent from the recorded migrations', () =>
    Effect.gen(function* () {
      // Reject extra columns without migration history confirming a newer chain prefix.
      const sql = yield* SqlClient.SqlClient
      const outcome = yield* Effect.result(
        Effect.gen(function* () {
          yield* run
          yield* sql.unsafe(`ALTER TABLE notes ADD COLUMN smuggled TEXT`)
          yield* run
        }),
      )

      expect(outcome._tag).toBe('Failure')
      if (outcome._tag === 'Failure') expect(String(outcome.failure)).toContain('smuggled')
    }).pipe(Effect.provide(makeInMemorySqliteLayer())),
  )
})
