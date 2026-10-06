import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import { HybridLogicalClock } from '@tachuris/effect-slotdb/changes'
import {
  addOptional,
  key,
  migrateSchema,
  retype,
  SchemaIndex,
  seed,
} from '@tachuris/effect-slotdb/migration'
import { Db, projectionOf } from '@tachuris/effect-slotdb/records'
import { migrate } from '../migrator.ts'
import { makeInMemorySqliteLayer } from '../testing.ts'

const REQUIRED = SchemaIndex.seed({
  file: '0000',
  entities: {
    entry: seed(Schema.Struct({ id: key(1)(Schema.String), size: Schema.String })),
  },
})
const REQUIRED_RETYPED = REQUIRED.appendMigration({
  file: '0001',
  entities: {
    entry: migrateSchema(
      REQUIRED.schemas.entry,
      retype('size', Schema.NullOr(Schema.Number), {
        decodeFromOld: size => Number(size),
        encodeToOld: size => String(size ?? ''),
      }),
    ),
  },
})

const BARE = SchemaIndex.seed({
  file: '0000',
  entities: { entry: seed(Schema.Struct({ id: key(1)(Schema.String) })) },
})
const OPTIONAL = BARE.appendMigration({
  file: '0001',
  entities: { entry: migrateSchema(BARE.schemas.entry, addOptional('size', Schema.String)) },
})
const OPTIONAL_RETYPED = OPTIONAL.appendMigration({
  file: '0002',
  entities: {
    entry: migrateSchema(
      OPTIONAL.schemas.entry,
      retype('size', Schema.optional(Schema.NullOr(Schema.Number)), {
        decodeFromOld: size => Number(size),
        encodeToOld: size => (size == null ? undefined : String(size)),
      }),
    ),
  },
})

const testLayer = makeInMemorySqliteLayer().pipe(
  Layer.provideMerge(HybridLogicalClock.layer('test-device')),
)

const readBack = (index: typeof REQUIRED_RETYPED | typeof OPTIONAL_RETYPED) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const entry = index.typed.entry
    const found = yield* new Db(sql).find(entry, { id: 'one' })
    const projection = projectionOf(entry)
    const rows = yield* sql<Record<string, unknown>>`
      SELECT
        ${projection.columns}
      FROM
        ${sql(entry.table)}
    `
    return { found: found?.size, projected: projection.decode(rows[0]!).size }
  })

describe('a row written before a retype', () => {
  it.effect('reads a required nullable field from the retired column', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(REQUIRED)
      yield* new Db(sql).insert(REQUIRED.typed.entry, { id: 'one', size: '7' })
      yield* migrate(REQUIRED_RETYPED)
      expect(yield* readBack(REQUIRED_RETYPED)).toEqual({ found: 7, projected: 7 })
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect('reads an optional field from the retired column', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(OPTIONAL)
      yield* new Db(sql).insert(OPTIONAL.typed.entry, { id: 'one', size: '7' })
      yield* migrate(OPTIONAL_RETYPED)
      expect(yield* readBack(OPTIONAL_RETYPED)).toEqual({ found: 7, projected: 7 })
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect('reads an optional field as absent when both columns are NULL', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(OPTIONAL)
      yield* new Db(sql).insert(OPTIONAL.typed.entry, { id: 'one' })
      yield* migrate(OPTIONAL_RETYPED)
      expect(yield* readBack(OPTIONAL_RETYPED)).toEqual({ found: undefined, projected: undefined })
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect('reads a cleared field as absent with both schema versions', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const db = new Db(sql)
      yield* migrate(OPTIONAL)
      yield* db.insert(OPTIONAL.typed.entry, { id: 'one', size: '7' })
      yield* migrate(OPTIONAL_RETYPED)
      yield* db.update(OPTIONAL_RETYPED.typed.entry, { id: 'one' }, { size: null })
      expect(yield* readBack(OPTIONAL_RETYPED)).toEqual({ found: undefined, projected: undefined })
      expect((yield* db.find(OPTIONAL.typed.entry, { id: 'one' }))?.size).toBeUndefined()
    }).pipe(Effect.provide(testLayer)),
  )
})
