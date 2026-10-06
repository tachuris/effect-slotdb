import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import { Hlc, HybridLogicalClock } from '@tachuris/effect-slotdb/changes'
import {
  growOnly,
  key,
  remove,
  migrateSchema,
  retype,
  SchemaIndex,
  seed,
  withDefault,
} from '@tachuris/effect-slotdb/migration'
import { Db } from '@tachuris/effect-slotdb/records'
import { makeAddressing } from '@tachuris/effect-slotdb/replication'
import { boundTo } from '@tachuris/effect-slotdb/testing'
import { deriveMigrations } from '../ddl.ts'
import { migrate } from '../migrator.ts'
import { makeInMemorySqliteLayer } from '../testing.ts'

const OLDER = SchemaIndex.seed({
  file: '0000',
  entities: {
    entry: seed(
      Schema.Struct({
        id: key(1)(Schema.String),
        title: Schema.String,
        event: Schema.Literals(['Started', 'Skipped']),
      }),
    ),
  },
})
const NEWER = OLDER.appendMigration({
  file: '0001',
  entities: {
    entry: migrateSchema(
      OLDER.schemas.entry,
      retype('event', withDefault('Started')(Schema.Literals(['Started', 'Skipped', 'Paused'])), {
        encodeToOld: event => (event === 'Paused' ? 'Skipped' : event),
      }),
    ),
  },
})
const NEWEST = NEWER.appendMigration({
  file: '0002',
  entities: {
    entry: migrateSchema(
      NEWER.schemas.entry,
      retype(
        'event',
        withDefault('Started')(Schema.Literals(['Started', 'Skipped', 'Paused', 'Done'])),
        { encodeToOld: event => (event === 'Done' ? 'Paused' : event) },
      ),
    ),
  },
})
const OLDER_ADDRESS = makeAddressing(OLDER)
const NEWER_ADDRESS = makeAddressing(NEWER)
const OLDER_PEER = boundTo(OLDER)
const NEWER_PEER = boundTo(NEWER)

const DEFAULTED = SchemaIndex.seed({
  file: '0000',
  entities: {
    entry: seed(
      Schema.Struct({
        id: key(1)(Schema.String),
        event: withDefault('Started')(Schema.Literals(['Started', 'Skipped'])),
      }),
    ),
  },
})
const RETYPED = DEFAULTED.appendMigration({
  file: '0001',
  entities: {
    entry: migrateSchema(
      DEFAULTED.schemas.entry,
      retype('event', withDefault('Paused')(Schema.Literals(['Started', 'Skipped', 'Paused']))),
    ),
  },
})

const testLayer = (index: SchemaIndex) =>
  Layer.effectDiscard(migrate(index)).pipe(
    Layer.provideMerge(makeInMemorySqliteLayer()),
    Layer.provideMerge(HybridLogicalClock.layer('test-device')),
  )

describe('retiring a required column', () => {
  it('rejects a retype without encodeToOld', () => {
    const retyped = OLDER.appendMigration({
      file: '0001',
      entities: {
        entry: migrateSchema(
          OLDER.schemas.entry,
          // @ts-expect-error: the retired column needs a value on each insert
          retype('event', Schema.Literals(['Started', 'Skipped', 'Paused'])),
        ),
      },
    })
    expect(() => deriveMigrations(retyped.chain)).toThrow(/retiring 'entry.event'.*encodeToOld/)
  })

  it('rejects removal of a required source without a default', () => {
    const removed = OLDER.appendMigration({
      file: '0001',
      entities: { entry: migrateSchema(OLDER.schemas.entry, remove('event')) },
    })
    expect(() => deriveMigrations(removed.chain)).toThrow(/retiring 'entry.event'/)
  })

  it('rejects removal of the live field that fills a retired column', () => {
    const removed = NEWER.appendMigration({
      file: '0002',
      entities: { entry: migrateSchema(NEWER.schemas.entry, remove('event')) },
    })
    expect(() => deriveMigrations(removed.chain)).toThrow(/retiring 'entry.event'/)
  })

  it('accepts a retype with encodeToOld', () => {
    expect(() => deriveMigrations(NEWEST.chain)).not.toThrow()
  })

  it.effect('inserts after retiring a nullable source without a default', () => {
    const nullable = SchemaIndex.seed({
      file: '0000',
      entities: {
        entry: seed(
          Schema.Struct({
            id: key(1)(Schema.String),
            event: Schema.NullOr(Schema.Literals(['Started', 'Skipped'])),
          }),
        ),
      },
    })
    const current = nullable.appendMigration({
      file: '0001',
      entities: {
        entry: migrateSchema(
          nullable.schemas.entry,
          retype(
            'event',
            withDefault('Started')(Schema.Literals(['Started', 'Skipped', 'Paused'])),
          ),
        ),
      },
    })
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const db = new Db(sql)
      yield* db.insert(current.typed.entry, { id: 'one', event: 'Paused' })
      expect((yield* db.find(current.typed.entry, { id: 'one' }))?.event).toBe('Paused')
      expect((yield* db.find(nullable.typed.entry, { id: 'one' }))?.event).toBeNull()
    }).pipe(Effect.provide(testLayer(current)))
  })

  it.effect('inserts and puts rows when the retired source declares a default', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const db = new Db(sql)
      yield* db.insert(RETYPED.typed.entry, { id: 'one', event: 'Paused' })
      yield* db.put(RETYPED.typed.entry, { id: 'two', event: 'Skipped' })
      expect((yield* db.find(RETYPED.typed.entry, { id: 'one' }))?.event).toBe('Paused')
      expect((yield* db.find(RETYPED.typed.entry, { id: 'two' }))?.event).toBe('Skipped')
      expect((yield* db.find(DEFAULTED.typed.entry, { id: 'one' }))?.event).toBe('Started')
      yield* db.put(RETYPED.typed.entry, { id: 'one', event: 'Skipped' })
      expect((yield* db.find(RETYPED.typed.entry, { id: 'one' }))?.event).toBe('Skipped')
    }).pipe(Effect.provide(testLayer(RETYPED))),
  )
})

describe('a retype with encodeToOld', () => {
  it.effect.each(['insert', 'put'] as const)('fills the retired column on %s', method =>
    Effect.gen(function* () {
      const db = new Db(yield* SqlClient.SqlClient)
      yield* db[method](NEWER.typed.entry, { id: 'one', title: 'Reading', event: 'Paused' })
      expect((yield* db.find(NEWER.typed.entry, { id: 'one' }))?.event).toBe('Paused')
      expect((yield* db.find(OLDER.typed.entry, { id: 'one' }))?.event).toBe('Skipped')
    }).pipe(Effect.provide(testLayer(NEWER))),
  )

  it.effect.each(['insert', 'put'] as const)(
    'fills the retired column from the default on %s',
    method =>
      Effect.gen(function* () {
        const db = new Db(yield* SqlClient.SqlClient)
        yield* db[method](NEWER.typed.entry, { id: 'one', title: 'Reading' })
        expect((yield* db.find(NEWER.typed.entry, { id: 'one' }))?.event).toBe('Started')
        expect((yield* db.find(OLDER.typed.entry, { id: 'one' }))?.event).toBe('Started')
      }).pipe(Effect.provide(testLayer(NEWER))),
  )

  it.effect('keeps both columns when a put omits the field', () =>
    Effect.gen(function* () {
      const db = new Db(yield* SqlClient.SqlClient)
      yield* db.insert(NEWER.typed.entry, { id: 'one', title: 'Reading', event: 'Paused' })
      yield* db.put(NEWER.typed.entry, { id: 'one', title: 'Writing' })
      expect((yield* db.find(NEWER.typed.entry, { id: 'one' }))?.event).toBe('Paused')
      expect((yield* db.find(OLDER.typed.entry, { id: 'one' }))?.event).toBe('Skipped')
    }).pipe(Effect.provide(testLayer(NEWER))),
  )

  it.effect('keeps a retired value from an older peer when a put omits the field', () =>
    Effect.gen(function* () {
      const page = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* new Db(sql).insert(OLDER.typed.entry, {
          id: 'one',
          title: 'Reading',
          event: 'Skipped',
        })
        return (yield* OLDER_PEER.changesSince(sql)).changes
      }).pipe(Effect.provide(testLayer(OLDER)))

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const db = new Db(sql)
        yield* NEWER_PEER.applyChanges(sql, page)
        const { cursor } = yield* NEWER_PEER.changesSince(sql)
        yield* db.put(NEWER.typed.entry, { id: 'one', title: 'Writing' })
        expect((yield* db.find(OLDER.typed.entry, { id: 'one' }))?.event).toBe('Skipped')
        const oldEvent = OLDER_ADDRESS.change('entry', ['one'], 'event', 'Skipped', Hlc.new(0))
        const later = (yield* NEWER_PEER.changesSince(sql, { cursor })).changes
        expect(later.map(change => change.fieldId)).not.toContain(oldEvent.fieldId)
      }).pipe(Effect.provide(testLayer(NEWER)))
    }),
  )

  it.effect('fills the retired column on update', () =>
    Effect.gen(function* () {
      const db = new Db(yield* SqlClient.SqlClient)
      yield* db.insert(NEWER.typed.entry, { id: 'one', title: 'Reading', event: 'Paused' })
      yield* db.update(NEWER.typed.entry, { id: 'one' }, { event: 'Started' })
      expect((yield* db.find(OLDER.typed.entry, { id: 'one' }))?.event).toBe('Started')
    }).pipe(Effect.provide(testLayer(NEWER))),
  )

  it.effect('fills every column of a chained retype', () =>
    Effect.gen(function* () {
      const db = new Db(yield* SqlClient.SqlClient)
      yield* db.insert(NEWEST.typed.entry, { id: 'one', title: 'Reading', event: 'Done' })
      expect((yield* db.find(NEWEST.typed.entry, { id: 'one' }))?.event).toBe('Done')
      expect((yield* db.find(NEWER.typed.entry, { id: 'one' }))?.event).toBe('Paused')
      expect((yield* db.find(OLDER.typed.entry, { id: 'one' }))?.event).toBe('Skipped')
    }).pipe(Effect.provide(testLayer(NEWEST))),
  )

  it.effect('lets a peer without the retype insert a row from a newer peer', () =>
    Effect.gen(function* () {
      const page = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* new Db(sql).insert(NEWER.typed.entry, {
          id: 'one',
          title: 'Reading',
          event: 'Paused',
        })
        return (yield* NEWER_PEER.changesSince(sql)).changes
      }).pipe(Effect.provide(testLayer(NEWER)))

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* OLDER_PEER.applyChanges(sql, page)
        const row = yield* new Db(sql).find(OLDER.typed.entry, { id: 'one' })
        expect(row?.title).toBe('Reading')
        expect(row?.event).toBe('Skipped')
      }).pipe(Effect.provide(testLayer(OLDER)))
    }),
  )
})

describe('a row split across pages', () => {
  it.effect('merges sets while the row waits for a required value', () => {
    const index = SchemaIndex.seed({
      file: '0000',
      entities: {
        entry: seed(
          Schema.Struct({
            id: key(1)(Schema.String),
            title: Schema.String,
            tags: growOnly(Schema.NullOr(Schema.fromJsonString(Schema.Array(Schema.String)))),
          }),
        ),
      },
    })
    const peer = boundTo(index)
    const { change } = makeAddressing(index)
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* peer.applyChanges(sql, [change('entry', ['one'], 'tags', '["a"]', Hlc.new(20))])
      yield* peer.applyChanges(sql, [change('entry', ['one'], 'tags', '["b"]', Hlc.new(10))])
      const pending = (yield* peer.changesSince(sql)).changes
      expect(pending[0]?.value).toBe('["a","b"]')
      expect(pending[0]?.hlc).toEqual(Hlc.new(20))
      yield* peer.applyChanges(sql, [change('entry', ['one'], 'title', 'Reading', Hlc.new(21))])
      expect((yield* new Db(sql).find(index.typed.entry, { id: 'one' }))?.tags).toEqual(['a', 'b'])
    }).pipe(Effect.provide(testLayer(index)))
  })

  it.effect.each(['insert', 'put'] as const)(
    'keeps a local %s after draining pending values',
    method =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* OLDER_PEER.applyChanges(sql, [
          OLDER_ADDRESS.change('entry', ['one'], 'title', 'Reading', Hlc.new(20)),
          NEWER_ADDRESS.change('entry', ['one'], 'event', 'Paused', Hlc.new(21)),
        ])
        const db = new Db(sql)
        yield* db[method](OLDER.typed.entry, { id: 'one', title: 'Writing', event: 'Started' })
        const before = yield* OLDER_PEER.changesSince(sql)
        expect(yield* OLDER_PEER.drainOverflow(sql)).toBe(0)
        expect((yield* db.find(OLDER.typed.entry, { id: 'one' }))?.title).toBe('Writing')
        expect((yield* OLDER_PEER.changesSince(sql)).changes).toEqual(before.changes)
      }).pipe(Effect.provide(testLayer(OLDER))),
  )

  it.effect('relays an incomplete row and applies other rows in the batch', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const pending = [
        OLDER_ADDRESS.change('entry', ['one'], 'id', 'one', Hlc.new(10)),
        OLDER_ADDRESS.change('entry', ['one'], 'title', 'Reading', Hlc.new(10)),
        NEWER_ADDRESS.change('entry', ['one'], 'event', 'Paused', Hlc.new(11)),
      ]
      const complete = [
        OLDER_ADDRESS.change('entry', ['two'], 'title', 'Writing', Hlc.new(12)),
        OLDER_ADDRESS.change('entry', ['two'], 'event', 'Skipped', Hlc.new(12)),
      ]
      expect(yield* OLDER_PEER.applyChanges(sql, [...pending, ...complete])).toHaveLength(5)
      const db = new Db(sql)
      expect(yield* db.find(OLDER.typed.entry, { id: 'one' })).toBeUndefined()
      expect((yield* db.find(OLDER.typed.entry, { id: 'two' }))?.title).toBe('Writing')
      expect(yield* OLDER_PEER.drainOverflow(sql)).toBe(0)
      const relayed = (yield* OLDER_PEER.changesSince(sql)).changes
      for (const change of pending) expect(relayed).toContainEqual(change)
    }).pipe(Effect.provide(testLayer(OLDER))),
  )

  it.effect('merges pending values and creates the row when the required field arrives', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const title = OLDER_ADDRESS.change('entry', ['one'], 'title', 'Reading', Hlc.new(20))
      const future = NEWER_ADDRESS.change('entry', ['one'], 'event', 'Paused', Hlc.new(21))
      yield* OLDER_PEER.applyChanges(sql, [title, future])
      expect(
        yield* OLDER_PEER.applyChanges(sql, [
          OLDER_ADDRESS.change('entry', ['one'], 'title', 'Stale', Hlc.new(10)),
        ]),
      ).toEqual([])
      yield* OLDER_PEER.applyChanges(sql, [
        OLDER_ADDRESS.change('entry', ['one'], 'event', 'Skipped', Hlc.new(22)),
      ])
      const row = yield* new Db(sql).find(OLDER.typed.entry, { id: 'one' })
      expect(row?.title).toBe('Reading')
      expect(row?.event).toBe('Skipped')
      const relayed = (yield* OLDER_PEER.changesSince(sql)).changes
      expect(relayed).toContainEqual(title)
      expect(relayed).toContainEqual(future)
      const { cursor } = yield* OLDER_PEER.changesSince(sql)
      const page = yield* OLDER_PEER.changesSince(sql, { cursor })
      expect(page.changes).toEqual([])
    }).pipe(Effect.provide(testLayer(OLDER))),
  )
})
