import { describe, expect, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import { Hlc, HybridLogicalClock } from '@tachuris/effect-slotdb/changes'
import { migrateSchema, rename, seed } from '@tachuris/effect-slotdb/migration'
import { CounterpartSyncState, makePeerStore } from '@tachuris/effect-slotdb/replication'
import { boundTo, change, FIXTURE_INDEX, TEST_ACCOUNT } from '@tachuris/effect-slotdb/testing'
import { migrate } from '../migrator.ts'
import { makeInMemorySqliteLayer } from '../testing.ts'

const INDEX = FIXTURE_INDEX.appendMigration({
  file: '0008',
  name: 'counterpart-sync-state',
  entities: { counterpartSyncState: seed(CounterpartSyncState) },
})

const TestLayer = Layer.effectDiscard(migrate(INDEX)).pipe(
  Layer.provideMerge(makeInMemorySqliteLayer()),
  Layer.provideMerge(HybridLogicalClock.layer('test-peer')),
)

describe('counterpart sync cursors', () => {
  it.effect(
    'keeps independent progress across bindings without changing identity or replication',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const clock = yield* HybridLogicalClock
        const store = makePeerStore(sql, INDEX, clock)
        const peerId = yield* store.getOrCreatePeerId
        expect(yield* store.getOrCreateCounterpartSyncCursors('relay-one')).toEqual({
          pushCursor: 0,
          pullCursor: 0,
        })
        yield* store.setCounterpartSyncCursors('relay-one', 12, 34)
        expect(yield* store.getOrCreateCounterpartSyncCursors('relay-two')).toEqual({
          pushCursor: 0,
          pullCursor: 0,
        })
        yield* store.setCounterpartSyncCursors('relay-two', 5, 7)
        const rebound = makePeerStore(sql, INDEX, clock)
        expect(yield* rebound.getOrCreatePeerId).toBe(peerId)
        expect(yield* rebound.getOrCreateCounterpartSyncCursors('relay-one')).toEqual({
          pushCursor: 12,
          pullCursor: 34,
        })
        expect(yield* rebound.getOrCreateCounterpartSyncCursors('relay-two')).toEqual({
          pushCursor: 5,
          pullCursor: 7,
        })
        expect((yield* rebound.changesSince()).changes).toEqual([])
        expect(yield* rebound.getPeerSyncCursors).toEqual({ pushCursor: 0, pullCursor: 0 })
      }).pipe(Effect.provide(TestLayer)),
  )
  it.effect(
    'retains a deletion until every tracked counterpart acknowledges the local sequence',
    () =>
      Effect.gen(function* () {
        const store = makePeerStore(yield* SqlClient.SqlClient, INDEX, yield* HybridLogicalClock)
        const peerId = yield* store.getOrCreatePeerId
        yield* store.registerPeer(peerId, TEST_ACCOUNT, DateTime.makeUnsafe('2026-10-05T12:00:00Z'))
        yield* store.applyChanges([
          change('notes', ['a1'], 'title', 'Reading', Hlc.new(10)),
          change('notes', ['a1'], 'deletedAt', '2026-10-05T12:00:00Z', Hlc.new(20)),
        ])
        const { cursor } = yield* store.changesSince()
        yield* store.setCounterpartSyncCursors('relay-one', cursor, 9000)
        yield* store.setCounterpartSyncCursors('relay-two', cursor - 1, 8000)
        yield* store.setPeerSyncCursors(cursor, 9000)
        expect(yield* store.purgeTombstoned(TEST_ACCOUNT)).toMatchObject({
          purged: 0,
          retained: 1,
          selfBehind: true,
          blockedCounterparts: ['relay-two'],
        })
        yield* store.setCounterpartSyncCursors('relay-two', cursor, 8000)
        expect(yield* store.purgeTombstoned(TEST_ACCOUNT)).toMatchObject({
          purged: 1,
          retained: 0,
          selfBehind: false,
          blockedCounterparts: [],
        })
      }).pipe(Effect.provide(TestLayer)),
  )
  it.effect('upgrades a singleton store without adopting unidentified progress', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const clock = yield* HybridLogicalClock
      yield* migrate(FIXTURE_INDEX)
      const legacy = makePeerStore(sql, FIXTURE_INDEX, clock)
      const peerId = yield* legacy.getOrCreatePeerId
      yield* legacy.registerPeer(peerId, TEST_ACCOUNT, DateTime.makeUnsafe('2026-10-05T12:00:00Z'))
      yield* legacy.applyChanges([
        change('notes', ['a1'], 'title', 'Reading', Hlc.new(10)),
        change('notes', ['a1'], 'deletedAt', '2026-10-05T12:00:00Z', Hlc.new(20)),
      ])
      const before = yield* legacy.changesSince()
      yield* legacy.setPeerSyncCursors(before.cursor, 123)
      yield* migrate(INDEX)
      const upgraded = makePeerStore(sql, INDEX, clock)
      expect(yield* upgraded.getOrCreatePeerId).toBe(peerId)
      expect(yield* upgraded.changesSince()).toEqual(before)
      expect(yield* upgraded.getPeerSyncCursors).toEqual({
        pushCursor: before.cursor,
        pullCursor: 123,
      })
      expect(yield* upgraded.purgeTombstoned(TEST_ACCOUNT)).toMatchObject({
        purged: 0,
        retained: 1,
        selfBehind: true,
        blockedCounterparts: [],
      })
      expect(yield* upgraded.getOrCreateCounterpartSyncCursors('relay-one')).toEqual({
        pushCursor: 0,
        pullCursor: 0,
      })
      expect(yield* upgraded.purgeTombstoned(TEST_ACCOUNT)).toMatchObject({
        purged: 0,
        retained: 1,
        selfBehind: true,
        blockedCounterparts: ['relay-one'],
      })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(makeInMemorySqliteLayer(), HybridLogicalClock.layer('test-peer')),
      ),
    ),
  )

  it.effect('resolves renamed storage through the schema index and testing helpers', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const born = FIXTURE_INDEX.appendMigration({
        file: '0008',
        name: 'destinations',
        entities: {
          destinations: seed(
            Schema.Struct({
              destination: CounterpartSyncState.fields.counterpartId,
              pushed: CounterpartSyncState.fields.pushCursor,
              pulled: CounterpartSyncState.fields.pullCursor,
            }),
          ),
        },
      })
      const renamed = born.appendMigration({
        file: '0009',
        name: 'counterpart-names',
        renameEntity: { destinations: 'counterpartSyncState' },
        entities: {
          counterpartSyncState: migrateSchema(
            born.schemas.destinations,
            rename('destination', 'counterpartId'),
            rename('pushed', 'pushCursor'),
            rename('pulled', 'pullCursor'),
          ),
        },
      })
      yield* migrate(renamed)
      const helpers = boundTo(renamed)
      yield* helpers.setCounterpartSyncCursors(sql, 'relay-one', 9, 27)
      const store = makePeerStore(sql, renamed, yield* HybridLogicalClock)
      expect(yield* store.getOrCreateCounterpartSyncCursors('relay-one')).toEqual({
        pushCursor: 9,
        pullCursor: 27,
      })
      expect(yield* helpers.getOrCreateCounterpartSyncCursors(sql, 'relay-two')).toEqual({
        pushCursor: 0,
        pullCursor: 0,
      })
      expect((yield* store.changesSince()).changes).toEqual([])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(makeInMemorySqliteLayer(), HybridLogicalClock.layer('test-peer')),
      ),
    ),
  )

  it.effect('keeps roster observations as an additional purge requirement', () =>
    Effect.gen(function* () {
      const store = makePeerStore(yield* SqlClient.SqlClient, INDEX, yield* HybridLogicalClock)
      const at = DateTime.makeUnsafe('2026-10-05T12:00:00Z')
      const peerId = yield* store.getOrCreatePeerId
      yield* store.registerPeer(peerId, TEST_ACCOUNT, at)
      yield* store.registerPeer('phone', TEST_ACCOUNT, at)
      yield* store.applyChanges([
        change('notes', ['a1'], 'title', 'Reading', Hlc.new(10)),
        change('notes', ['a1'], 'deletedAt', '2026-10-05T12:00:00Z', Hlc.new(20)),
      ])
      const { cursor } = yield* store.changesSince()
      yield* store.setCounterpartSyncCursors('relay-one', cursor, 9000)
      expect(yield* store.purgeTombstoned(TEST_ACCOUNT)).toMatchObject({
        purged: 0,
        retained: 1,
        selfBehind: false,
        blockedBy: ['phone'],
        blockedCounterparts: [],
      })
      yield* store.observePeer('phone', TEST_ACCOUNT, at, store.chainPosition, cursor)
      expect(yield* store.purgeTombstoned(TEST_ACCOUNT)).toMatchObject({ purged: 1, retained: 0 })
    }).pipe(Effect.provide(TestLayer)),
  )
})
