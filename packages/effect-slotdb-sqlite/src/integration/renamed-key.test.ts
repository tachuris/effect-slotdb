import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import {
  SchemaIndex,
  migrateSchema,
  key,
  type Migration,
  rename,
  seed,
  shapeOf,
} from '@tachuris/effect-slotdb/migration'
import { HybridLogicalClock } from '@tachuris/effect-slotdb/changes'
import { Db } from '@tachuris/effect-slotdb/records'
import { makeInMemorySqliteLayer } from '../testing.ts'
import { migrate } from '../migrator.ts'

/**
 * A fixture with a renamed key field. Writes use the original column name while
 * application keys use the renamed field name.
 */

const born = {
  file: '0000',
  name: 'born',
  entities: {
    person: seed(Schema.Struct({ slug: key(1)(Schema.String), label: Schema.String })),
  },
} satisfies Migration

const renamed = {
  file: '0001',
  name: 'renamed',
  entities: { person: migrateSchema(shapeOf([born], 'person'), rename('slug', 'handle')) },
} satisfies Migration

const INDEX = new SchemaIndex([born, renamed])
const person = INDEX.typed.person

const AccountLayer = Layer.effectDiscard(migrate(INDEX)).pipe(
  Layer.provideMerge(makeInMemorySqliteLayer()),
  Layer.provideMerge(HybridLogicalClock.layer('test-peer')),
)

const withSql = <A, E, R>(
  f: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, never> =>
  Effect.flatMap(SqlClient.SqlClient, f).pipe(Effect.provide(AccountLayer)) as Effect.Effect<
    A,
    E,
    never
  >

describe('a renamed key field', () => {
  it('keeps the column it was born with', () => {
    const field = INDEX.entity('person').keyFields[0]
    expect(field.currentName).toBe('handle')
    expect(field.column).toBe('slug')
  })

  it('states the key by column, so an insert reaches a column the table has', () => {
    // The field name is handle, but storage retains the original key column name.
    const entity = INDEX.entity('person')
    expect(entity.keyValues(['ada'])).toEqual({ handle: 'ada' })
    expect(entity.keyColumnValues(['ada'])).toEqual({ slug: 'ada' })
  })

  it('inserts and reads back a row through the renamed key', () =>
    Effect.runPromise(
      withSql(sql =>
        Effect.gen(function* () {
          const db = new Db(sql)
          yield* db.insert(person, { handle: 'ada', label: 'Ada' })

          const found = yield* db.find(person, { handle: 'ada' })
          expect(found?.label).toBe('Ada')
          expect(found?.handle).toBe('ada')
        }),
      ),
    ))

  it('puts a row through the renamed key', () =>
    Effect.runPromise(
      withSql(sql =>
        Effect.gen(function* () {
          const db = new Db(sql)
          yield* db.put(person, { handle: 'grace', label: 'Grace' })
          yield* db.put(person, { handle: 'grace', label: 'Grace H' })

          const found = yield* db.find(person, { handle: 'grace' })
          expect(found?.label).toBe('Grace H')
        }),
      ),
    ))
})
