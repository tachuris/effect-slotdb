import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import { HybridLogicalClock } from '@tachuris/effect-slotdb/changes'
import type { RowOf } from '@tachuris/effect-slotdb/records'
import type { EntityEntry, StructFieldsOf } from '@tachuris/effect-slotdb/migration'
import { PeerRoster, type RosterEntry } from '@tachuris/effect-slotdb/replication'
import {
  FixtureLayer,
  TEST_ACCOUNT,
  applyChanges,
  changesSince,
  everyPeerReached,
  evictPeer,
  fieldOf,
  listPeers,
  makeInMemorySqliteLayer,
  observePeer,
  registerPeer,
  tableOf,
} from '../testing.ts'

// Check that derived roster field types match the published RosterEntry type.
type RosterFields = StructFieldsOf<typeof PeerRoster>
type RosterEntity = EntityEntry<RosterFields>
const _rosterRowAssignable: RosterEntry = {} as RowOf<RosterEntity>

const at = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)
const JOINED = at('2026-07-20T09:00:00.000Z')
const SEEN = at('2026-07-26T11:30:00.000Z')

const AccountLayer = FixtureLayer.pipe(
  Layer.provideMerge(makeInMemorySqliteLayer()),
  Layer.provideMerge(HybridLogicalClock.layer('test-peer')),
)

const withSql = <A, E, R>(f: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, f).pipe(Effect.provide(AccountLayer))

describe('the peer roster', () => {
  it.effect('replicates a registration, so a peer learns the peer exists', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* registerPeer(sql, 'laptop', TEST_ACCOUNT, JOINED)

        // Replicated key fields let the receiving peer identify the peer without
        // decoding the row ID.
        const outbound = yield* changesSince(sql, {})
        const peerChanges = outbound.changes.filter(c => tableOf(c) === 'peers')
        expect(peerChanges.map(fieldOf).sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual([
          'accountId',
          'peerId',
          'registeredAt',
        ])
        expect(peerChanges.some(c => tableOf(c) === 'peers')).toBe(true)
      }),
    ),
  )

  it.effect('does not restamp a peer it already knows', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* registerPeer(sql, 'laptop', TEST_ACCOUNT, JOINED)
        const before = yield* changesSince(sql, {})
        yield* registerPeer(sql, 'laptop', TEST_ACCOUNT, at('2026-07-25T09:00:00.000Z'))
        const after = yield* changesSince(sql, {})

        // Registration must preserve the original registration time and stamp.
        expect(after.changes.length).toBe(before.changes.length)
        const [entry] = yield* listPeers(sql, TEST_ACCOUNT)
        expect(entry.registeredAt).toEqual(JOINED)
      }),
    ),
  )

  it.effect('reports a peer with no observation as never seen', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* registerPeer(sql, 'phone', TEST_ACCOUNT, JOINED)

        // Missing observations must block maintenance for a registered peer.
        const [entry] = yield* listPeers(sql, TEST_ACCOUNT)
        expect(entry.lastSeenAt).toBeNull()
        expect(entry.chainPosition).toBeNull()
        expect(entry.pulledThrough).toBeNull()
        expect(yield* everyPeerReached(sql, TEST_ACCOUNT, '0001')).toBe(false)
      }),
    ),
  )

  it.effect('records an observation without replicating it', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* registerPeer(sql, 'laptop', TEST_ACCOUNT, JOINED)
        const before = yield* changesSince(sql, {})

        yield* observePeer(sql, 'laptop', TEST_ACCOUNT, SEEN, '0001', 0)

        const [entry] = yield* listPeers(sql, TEST_ACCOUNT)
        expect(entry.lastSeenAt).toEqual(SEEN)
        expect(entry.chainPosition).toBe('0001')
        expect(entry.pulledThrough).toBe(0)

        // Observations do not replicate because each peer records its own received reports.
        const after = yield* changesSince(sql, {})
        expect(after.changes.length).toBe(before.changes.length)
      }),
    ),
  )

  it.effect('leaves a peer that is not in the roster alone', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        // Observing an unknown peer must not create a registration.
        const known = yield* observePeer(sql, 'stranger', TEST_ACCOUNT, SEEN, '0001', 0)
        expect(known).toBe(false)
        expect(yield* listPeers(sql, TEST_ACCOUNT)).toEqual([])
      }),
    ),
  )

  it.effect('confirms chain progress only after every active peer reports the position', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* registerPeer(sql, 'laptop', TEST_ACCOUNT, JOINED)
        yield* registerPeer(sql, 'phone', TEST_ACCOUNT, JOINED)
        yield* observePeer(sql, 'laptop', TEST_ACCOUNT, SEEN, '0001', 0)

        expect(yield* everyPeerReached(sql, TEST_ACCOUNT, '0001')).toBe(false)

        yield* observePeer(sql, 'phone', TEST_ACCOUNT, SEEN, '0001', 0)
        expect(yield* everyPeerReached(sql, TEST_ACCOUNT, '0001')).toBe(true)

        // A peer behind the required position blocks the check.
        expect(yield* everyPeerReached(sql, TEST_ACCOUNT, '0002')).toBe(false)
      }),
    ),
  )

  it.effect('reports false before receiving peer registrations', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        // An empty roster must not indicate that every peer has reached the required position.
        expect(yield* everyPeerReached(sql, TEST_ACCOUNT, '0001')).toBe(false)
      }),
    ),
  )

  it.effect('leaves an evicted peer alone rather than observing it', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* registerPeer(sql, 'old-laptop', TEST_ACCOUNT, JOINED)
        yield* evictPeer(sql, 'old-laptop', TEST_ACCOUNT)

        // Observing an evicted peer must not undo eviction or report an update.
        expect(yield* observePeer(sql, 'old-laptop', TEST_ACCOUNT, SEEN, '0001', 0)).toBe(false)
      }),
    ),
  )

  it.effect('rejects an empty active roster after eviction', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* registerPeer(sql, 'laptop', TEST_ACCOUNT, JOINED)
        yield* registerPeer(sql, 'old-laptop', TEST_ACCOUNT, JOINED)
        yield* observePeer(sql, 'laptop', TEST_ACCOUNT, SEEN, '0001', 0)
        yield* observePeer(sql, 'old-laptop', TEST_ACCOUNT, SEEN, '0001', 0)
        yield* evictPeer(sql, 'old-laptop', TEST_ACCOUNT)

        // Eviction must not permit maintenance before the remaining peers reach the
        // required position.
        expect(yield* everyPeerReached(sql, TEST_ACCOUNT, '0002')).toBe(false)
        expect(yield* everyPeerReached(sql, TEST_ACCOUNT, '0001')).toBe(true)
      }),
    ),
  )

  it.effect('stops counting a peer once it is evicted', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* registerPeer(sql, 'laptop', TEST_ACCOUNT, JOINED)
        yield* registerPeer(sql, 'old-laptop', TEST_ACCOUNT, JOINED)
        yield* observePeer(sql, 'laptop', TEST_ACCOUNT, SEEN, '0001', 0)

        // Eviction removes an unavailable peer from progress checks.
        expect(yield* everyPeerReached(sql, TEST_ACCOUNT, '0001')).toBe(false)

        const evicted = yield* evictPeer(sql, 'old-laptop', TEST_ACCOUNT)
        expect(evicted).toBe(true)

        expect(yield* everyPeerReached(sql, TEST_ACCOUNT, '0001')).toBe(true)
        expect((yield* listPeers(sql, TEST_ACCOUNT)).map(e => e.peerId)).toEqual(['laptop'])
      }),
    ),
  )

  it.effect('replicates the eviction, so a peer does not put the peer back', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* registerPeer(sql, 'old-laptop', TEST_ACCOUNT, JOINED)
        yield* evictPeer(sql, 'old-laptop', TEST_ACCOUNT)

        const outbound = yield* changesSince(sql, {})
        const tombstone = outbound.changes.filter(
          c => tableOf(c) === 'peers' && fieldOf(c) === 'deletedAt',
        )
        expect(tombstone.length).toBe(1)
        expect(tombstone[0].value).not.toBeNull()
      }),
    ),
  )
})

describe('the roster between two peers', () => {
  // Use a separate memory database per peer and share the layer within the test.
  // Rows move between peers only through replicated changes.
  const PeerLayer = FixtureLayer.pipe(Layer.provideMerge(HybridLogicalClock.layer('test-peer')))
  const onPeer = <A, R>(program: Effect.Effect<A, unknown, R>): Effect.Effect<A> =>
    program.pipe(Effect.provide(PeerLayer)) as Effect.Effect<A>

  it.effect('a registration on one peer makes the other one know the peer exists', () =>
    Effect.gen(function* () {
      // Register and page changes within one peer layer before sending the changes to
      // another peer.
      const outbound = yield* onPeer(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* registerPeer(sql, 'laptop', TEST_ACCOUNT, JOINED)
          return yield* changesSince(sql, {})
        }),
      )

      yield* onPeer(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* applyChanges(sql, outbound.changes)

          // A replicated registration must block maintenance before the peer is
          // observed locally.
          const [entry] = yield* listPeers(sql, TEST_ACCOUNT)
          expect(entry.peerId).toBe('laptop')
          expect(entry.registeredAt).toEqual(JOINED)
          expect(entry.lastSeenAt).toBeNull()
          expect(yield* everyPeerReached(sql, TEST_ACCOUNT, '0001')).toBe(false)
        }),
      )
    }),
  )

  it.effect('an eviction on one peer removes it from the other', () =>
    Effect.gen(function* () {
      // Register and evict within one database while recording both outgoing pages.
      const { registration, eviction } = yield* onPeer(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* registerPeer(sql, 'old-laptop', TEST_ACCOUNT, JOINED)
          const registration = yield* changesSince(sql, {})
          yield* evictPeer(sql, 'old-laptop', TEST_ACCOUNT)
          const eviction = yield* changesSince(sql, { cursor: registration.cursor })
          return { registration, eviction }
        }),
      )

      yield* onPeer(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* applyChanges(sql, registration.changes)
          expect((yield* listPeers(sql, TEST_ACCOUNT)).length).toBe(1)

          // Eviction must replicate so the removed peer stops blocking maintenance on
          // other peers.
          yield* applyChanges(sql, eviction.changes)
          expect(yield* listPeers(sql, TEST_ACCOUNT)).toEqual([])
        }),
      )
    }),
  )
})
