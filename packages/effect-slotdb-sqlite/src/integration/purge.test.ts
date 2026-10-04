import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import { Change, Hlc, HybridLogicalClock } from '@tachuris/effect-slotdb/changes'
import { encodeRowId, FieldId } from '@tachuris/effect-slotdb/migration'
import {
  FixtureLayer,
  TEST_ACCOUNT,
  applyChanges,
  changesSince,
  entityIdFor,
  evictPeer,
  keyValues,
  makeInMemorySqliteLayer,
  observePeer,
  purgeTombstoned,
  registerPeer,
  stampChanges,
} from '../testing.ts'

const at = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)
const JOINED = at('2026-07-20T09:00:00.000Z')
const SEEN = at('2026-07-26T11:30:00.000Z')
const DELETED_AT = '2026-07-27T08:00:00.000Z'
const DELETED = at(DELETED_AT)

const AccountLayer = FixtureLayer.pipe(
  Layer.provideMerge(makeInMemorySqliteLayer()),
  Layer.provideMerge(HybridLogicalClock.layer('test-peer')),
)

const withSql = <A, E, R>(f: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, f).pipe(Effect.provide(AccountLayer))

/** Write an activity locally and stamp it, the way a repository would. */
const writeActivity = (sql: SqlClient.SqlClient, id: string, hlc: Hlc) =>
  Effect.gen(function* () {
    const values = { id, title: 'Reading', kind: 'plain' }
    yield* sql`
      INSERT INTO
        notes ${sql.insert({ __rowId: encodeRowId([id]), ...values })}
    `
    return yield* stampChanges(
      sql,
      hlc,
      'notes',
      encodeRowId([id]),
      {},
      {
        ...keyValues('notes', [id]),
        title: 'Reading',
        kind: 'plain',
      },
    )
  })

const deleteActivity = (sql: SqlClient.SqlClient, id: string, hlc: Hlc) =>
  Effect.gen(function* () {
    yield* sql`
      UPDATE notes
      SET
        deletedAt = ${DELETED_AT}
      WHERE
        id = ${id}
    `
    return yield* stampChanges(sql, hlc, 'notes', encodeRowId([id]), {}, { deletedAt: DELETED })
  })

const activityRows = (sql: SqlClient.SqlClient) =>
  sql`
    SELECT
      id
    FROM
      notes
  `.pipe(Effect.map(rows => rows.map(row => (row as { id: string }).id)))

/** Put this store on the roster as a peer that has pushed everything it holds. */
const asCaughtUpPeer = (sql: SqlClient.SqlClient, peerId: string) =>
  Effect.gen(function* () {
    yield* registerPeer(sql, peerId, TEST_ACCOUNT, JOINED)
    const { cursor } = yield* changesSince(sql, {})
    yield* sql`
      INSERT INTO
        peerSyncState ${sql.insert({
          __rowId: encodeRowId(['0']),
          id: 0,
          peerId,
          pushCursor: cursor,
          pullCursor: cursor,
        })}
      ON CONFLICT (id) DO UPDATE
      SET
        pushCursor = excluded.pushCursor
    `
  })

describe('purging tombstoned rows', () => {
  it.effect('removes a deleted row once every peer has taken the deletion', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* writeActivity(sql, 'a1', Hlc.new(10))
        yield* deleteActivity(sql, 'a1', Hlc.new(20))
        yield* registerPeer(sql, 'phone', TEST_ACCOUNT, JOINED)
        yield* asCaughtUpPeer(sql, 'laptop')

        // The phone reports a position after the deletion, confirming receipt.
        const { cursor } = yield* changesSince(sql, {})
        yield* observePeer(sql, 'phone', TEST_ACCOUNT, SEEN, '0002', cursor)

        const report = yield* purgeTombstoned(sql, TEST_ACCOUNT)
        expect(report.purged).toBe(1)
        expect(report.blockedBy).toEqual([])
        expect(yield* activityRows(sql)).toEqual([])
      }),
    ),
  )

  it.effect('refuses while a peer has reported nothing, and names it', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* writeActivity(sql, 'a1', Hlc.new(10))
        yield* deleteActivity(sql, 'a1', Hlc.new(20))
        yield* asCaughtUpPeer(sql, 'laptop')
        yield* registerPeer(sql, 'phone', TEST_ACCOUNT, JOINED)

        // Missing peer observations must prevent row removal.
        const report = yield* purgeTombstoned(sql, TEST_ACCOUNT)
        expect(report.purged).toBe(0)
        expect(report.retained).toBe(1)
        expect(report.blockedBy).toEqual(['phone'])
        expect(yield* activityRows(sql)).toEqual(['a1'])
      }),
    ),
  )

  it.effect('refuses while a peer has reported a position behind the deletion', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* writeActivity(sql, 'a1', Hlc.new(10))
        yield* registerPeer(sql, 'phone', TEST_ACCOUNT, JOINED)
        const { cursor: beforeDelete } = yield* changesSince(sql, {})

        yield* deleteActivity(sql, 'a1', Hlc.new(20))
        yield* asCaughtUpPeer(sql, 'laptop')

        // The phone's position precedes the deletion, so purging would permit the row to be restored.
        yield* observePeer(sql, 'phone', TEST_ACCOUNT, SEEN, '0002', beforeDelete)

        const report = yield* purgeTombstoned(sql, TEST_ACCOUNT)
        expect(report.purged).toBe(0)
        expect(report.blockedBy).toEqual(['phone'])
      }),
    ),
  )

  it.effect('refuses while this peer has not pushed the deletion anywhere', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* writeActivity(sql, 'a1', Hlc.new(10))
        yield* asCaughtUpPeer(sql, 'laptop')
        yield* deleteActivity(sql, 'a1', Hlc.new(20))

        // Unpushed local tombstones must prevent purging even with one registered peer.
        const report = yield* purgeTombstoned(sql, TEST_ACCOUNT)
        expect(report.purged).toBe(0)
        // Report unpushed local writes separately from remote peers awaiting observation.
        expect(report.selfBehind).toBe(true)
        expect(report.blockedBy).toEqual([])
      }),
    ),
  )

  it.effect('does nothing while the roster has not reached this peer', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* writeActivity(sql, 'a1', Hlc.new(10))
        yield* deleteActivity(sql, 'a1', Hlc.new(20))

        // An empty roster must prevent purging because peer progress is unknown.
        const report = yield* purgeTombstoned(sql, TEST_ACCOUNT)
        expect(report).toMatchObject({ purged: 0, retained: 1, rosterSize: 0 })
      }),
    ),
  )

  it.effect('takes the stamps and the overflow with the row', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* writeActivity(sql, 'a1', Hlc.new(10))
        // Stamp unknown fields stored in overflow.
        yield* applyChanges(sql, [
          Change.make({
            entityId: entityIdFor('notes'),
            rowId: encodeRowId(['a1']),
            fieldId: FieldId.make('ffffffffffffffff'),
            value: 'from a newer peer',
            hlc: Hlc.new(15),
          }),
        ])
        yield* deleteActivity(sql, 'a1', Hlc.new(20))
        yield* asCaughtUpPeer(sql, 'laptop')
        expect(
          (yield* sql`
            SELECT
              Count(*) AS n
            FROM
              fieldOverflow
          `)[0],
        ).toMatchObject({ n: 1 })

        const report = yield* purgeTombstoned(sql, TEST_ACCOUNT)
        expect(report.purged).toBe(1)

        // Delete overflow with the row so draining cannot recreate the purged row.
        // Roster stamps remain, so count stamps for the purged row only.
        const rowId = encodeRowId(['a1'])
        const leftovers = yield* sql`
          SELECT
            (
              SELECT
                Count(*)
              FROM
                fieldStamps
              WHERE
                rowId = ${rowId}
            ) AS stamps,
            (
              SELECT
                Count(*)
              FROM
                fieldOverflow
              WHERE
                rowId = ${rowId}
            ) AS overflow
        `
        expect(leftovers[0]).toMatchObject({ stamps: 0, overflow: 0 })
      }),
    ),
  )

  it.effect('permits purging after eviction removes an unavailable peer', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* writeActivity(sql, 'a1', Hlc.new(10))
        yield* deleteActivity(sql, 'a1', Hlc.new(20))
        yield* asCaughtUpPeer(sql, 'laptop')
        yield* registerPeer(sql, 'old-laptop', TEST_ACCOUNT, JOINED)

        expect((yield* purgeTombstoned(sql, TEST_ACCOUNT)).purged).toBe(0)

        // Evict unavailable peers explicitly to stop their missing reports from
        // blocking purging.
        yield* evictPeer(sql, 'old-laptop', TEST_ACCOUNT)
        // Push the eviction before the local peer can confirm progress.
        yield* asCaughtUpPeer(sql, 'laptop')

        const report = yield* purgeTombstoned(sql, TEST_ACCOUNT)
        expect(report.purged).toBe(1)
        expect(yield* activityRows(sql)).toEqual([])

        // Retain evicted peer rows and tombstones to prevent registration from undoing eviction.
        const roster = yield* sql`
          SELECT
            peerId
          FROM
            peers
          WHERE
            deletedAt IS NOT NULL
        `
        expect(roster.length).toBe(1)
      }),
    ),
  )
})

describe('purge safety checks', () => {
  // Use separate memory databases so replication is the only way rows move between peers.
  const onPeer = <A>(program: Effect.Effect<A, unknown, SqlClient.SqlClient>): Effect.Effect<A> =>
    program.pipe(
      Effect.provide(FixtureLayer.pipe(Layer.provideMerge(makeInMemorySqliteLayer()))),
    ) as Effect.Effect<A>

  it.effect('a stale peer puts the row back when the row is removed without the evidence', () =>
    Effect.gen(function* () {
      // The stale peer retains the live row without receiving the deletion.
      const stalePush = yield* onPeer(
        Effect.flatMap(SqlClient.SqlClient, sql =>
          writeActivity(sql, 'a1', Hlc.new(10, 0, 'phone')),
        ),
      )

      yield* onPeer(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* applyChanges(sql, stalePush)
          yield* deleteActivity(sql, 'a1', Hlc.new(20, 0, 'laptop'))

          // Remove the row and stamps to show why purging requires the phone's progress report.
          yield* sql`
  DELETE FROM notes
  WHERE
    id = 'a1'
`
          yield* sql`
  DELETE FROM fieldStamps
`

          yield* applyChanges(sql, stalePush)
          expect(yield* activityRows(sql)).toEqual(['a1'])
        }),
      )
    }),
  )

  it.effect('the same stale push changes nothing once the tombstone has reached the peer', () =>
    Effect.gen(function* () {
      const stalePush = yield* onPeer(
        Effect.flatMap(SqlClient.SqlClient, sql =>
          writeActivity(sql, 'a1', Hlc.new(10, 0, 'phone')),
        ),
      )

      const tombstone = yield* onPeer(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* applyChanges(sql, stalePush)
          return yield* deleteActivity(sql, 'a1', Hlc.new(20, 0, 'laptop'))
        }),
      )

      yield* onPeer(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          // The peer receives the tombstone before purging, so its stale edits cannot
          // restore the row.
          yield* applyChanges(sql, stalePush)
          yield* applyChanges(sql, tombstone)
          yield* applyChanges(sql, stalePush)

          const rows = yield* sql`
            SELECT
              deletedAt
            FROM
              notes
            WHERE
              id = 'a1'
          `
          expect(rows[0]).toMatchObject({ deletedAt: DELETED_AT })
        }),
      )
    }),
  )
})
