import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import { Hlc, HybridLogicalClock } from '@tachuris/effect-slotdb/changes'
import { EPOCH, encodeRowId } from '@tachuris/effect-slotdb/migration'
import { FIXTURE_INDEX } from '@tachuris/effect-slotdb/testing'
import { Db, projectionOf } from '@tachuris/effect-slotdb/records'
import {
  FixtureLayer,
  applyChanges,
  change,
  changesSince,
  fieldOf,
  makeInMemorySqliteLayer,
  tableOf,
} from '../testing'

const at = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)
const JOINED = at('2026-07-20T09:00:00.000Z')
const SEEN = at('2026-07-26T11:30:00.000Z')

const handles = FIXTURE_INDEX.typed
const readings = handles.readings
const notes = handles.notes
const labels = handles.labels
const activityGroupLinks = handles.activityGroupLinks
const aliases = handles.aliases

const AccountLayer = FixtureLayer.pipe(
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

describe('the row plane', () => {
  it.effect('inserts a row and reads it back by its key', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(readings, {
          noteId: 'n1',
          readerId: 'r1',
          lastReadAt: '2026-07-29',
        })

        const row = yield* new Db(sql).find(readings, { noteId: 'n1', readerId: 'r1' })
        expect(row?.lastReadAt).toBe('2026-07-29')
      }),
    ),
  )

  it.effect('an absent optional field reads back as undefined instead of null', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(notes, { id: 'n1', title: 'First' })

        const row = yield* new Db(sql).find(notes, { id: 'n1' })
        expect(row?.title).toBe('First')
        expect(row?.summary).toBeUndefined()
      }),
    ),
  )

  it.effect('insert fails when the row already exists', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(readings, {
          noteId: 'n1',
          readerId: 'r1',
          lastReadAt: '2026-07-29',
        })
        const exit = yield* Effect.exit(
          new Db(sql).insert(readings, { noteId: 'n1', readerId: 'r1', lastReadAt: '2026-07-30' }),
        )
        expect(exit._tag).toBe('Failure')
      }),
    ),
  )

  it.effect('put upserts, inserting then updating in one operation', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).put(readings, { noteId: 'n1', readerId: 'r1', lastReadAt: '2026-07-29' })
        yield* new Db(sql).put(readings, { noteId: 'n1', readerId: 'r1', lastReadAt: '2026-07-30' })

        const row = yield* new Db(sql).find(readings, { noteId: 'n1', readerId: 'r1' })
        expect(row?.lastReadAt).toBe('2026-07-30')
      }),
    ),
  )

  it.effect('a local-only write stamps nothing', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(readings, {
          noteId: 'n1',
          readerId: 'r1',
          lastReadAt: '2026-07-29',
        })
        const before = yield* changesSince(sql, {})

        // Roster observation writes update local columns without replication.
        const roster = handles.peers
        yield* new Db(sql).insert(roster, {
          peerId: 'laptop',
          accountId: 'acct',
          registeredAt: JOINED,
        })
        const afterRegistration = yield* changesSince(sql, {})
        expect(afterRegistration.changes.length).toBe(before.changes.length + 3)

        // A local-only update to the roster's observation fields stamps nothing.
        const beforeObserve = yield* changesSince(sql, {})
        yield* new Db(sql).update(
          roster,
          { peerId: 'laptop', accountId: 'acct' },
          { lastSeenAt: SEEN, chainPosition: '0001', pulledThrough: 0 },
        )
        const afterObserve = yield* changesSince(sql, {})
        expect(afterObserve.changes.length).toBe(beforeObserve.changes.length)
      }),
    ),
  )

  it.effect('an update reports whether it matched', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(readings, {
          noteId: 'n1',
          readerId: 'r1',
          lastReadAt: '2026-07-29',
        })

        const hit = yield* new Db(sql).update(
          readings,
          { noteId: 'n1', readerId: 'r1' },
          { lastReadAt: '2026-07-30' },
        )
        expect(hit.matched).toBe(true)

        const miss = yield* new Db(sql).update(
          readings,
          { noteId: 'n1', readerId: 'nope' },
          { lastReadAt: '2026-07-30' },
        )
        expect(miss.matched).toBe(false)
      }),
    ),
  )

  it.effect('delete hides a row, and find excludes it by default', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(readings, {
          noteId: 'n1',
          readerId: 'r1',
          lastReadAt: '2026-07-29',
        })

        yield* new Db(sql).remove(readings, { noteId: 'n1', readerId: 'r1' })

        expect(yield* new Db(sql).find(readings, { noteId: 'n1', readerId: 'r1' })).toBeUndefined()
        // Include tombstoned rows to check existence while omitting the tombstone from RowOf.
        const row = yield* new Db(sql).find(
          readings,
          { noteId: 'n1', readerId: 'r1' },
          { includeDeleted: true },
        )
        expect(row).toBeDefined()
        expect(row?.noteId).toBe('n1')
      }),
    ),
  )

  it.effect('a delete replicates, so a peer sees the tombstone', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(readings, {
          noteId: 'n1',
          readerId: 'r1',
          lastReadAt: '2026-07-29',
        })
        yield* new Db(sql).remove(readings, { noteId: 'n1', readerId: 'r1' })

        const outbound = yield* changesSince(sql, {})
        const tombstone = outbound.changes.filter(
          c => tableOf(c) === 'readings' && fieldOf(c) === 'deletedAt',
        )
        expect(tombstone.length).toBe(1)
        expect(tombstone[0].value).not.toBeNull()
      }),
    ),
  )

  it.effect('all filters by equality and orders by a field', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(readings, {
          noteId: 'n2',
          readerId: 'r1',
          lastReadAt: '2026-07-30',
        })
        yield* new Db(sql).insert(readings, {
          noteId: 'n1',
          readerId: 'r1',
          lastReadAt: '2026-07-29',
        })

        const rows = yield* new Db(sql).all(readings, { orderBy: 'noteId' })
        expect(rows.map(r => r.noteId)).toEqual(['n1', 'n2'])

        const filtered = yield* new Db(sql).all(readings, { where: { noteId: 'n1' } })
        expect(filtered.length).toBe(1)
        expect(filtered[0].readerId).toBe('r1')
      }),
    ),
  )

  it.effect('a composite key addresses a row through a record instead of a tuple', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(readings, {
          noteId: 'n1',
          readerId: 'r1',
          lastReadAt: '2026-07-29',
        })

        const row = yield* new Db(sql).find(readings, { noteId: 'n1', readerId: 'r1' })
        expect(row?.lastReadAt).toBe('2026-07-29')

        // Different reader IDs identify different rows. Key field order does not affect identity.
        expect(yield* new Db(sql).find(readings, { noteId: 'n1', readerId: 'r2' })).toBeUndefined()
      }),
    ),
  )

  it.effect('the onCommit hook reports the entity names a write touched', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        const touched: string[] = []
        const hookDb = (sql: SqlClient.SqlClient) =>
          new Db(sql, (names: ReadonlyArray<string>) => Effect.sync(() => touched.push(...names)))

        yield* hookDb(sql).transaction(tx =>
          Effect.gen(function* () {
            yield* tx.insert(readings, { noteId: 'n1', readerId: 'r1', lastReadAt: '2026-07-29' })
            yield* tx.insert(readings, { noteId: 'n2', readerId: 'r1', lastReadAt: '2026-07-30' })
          }),
        )

        expect(touched).toEqual(['readings'])
      }),
    ),
  )

  it.effect('a put naming only some fields sets only those columns instead of the rest', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        // Populate a defaulted field, a local field, and a field added by a later migration.
        yield* new Db(sql).put(notes, {
          id: 'n1',
          title: 'first',
          kind: 'note',
          openedAt: '2026-07-29',
          summary: 'the first',
        })

        // A partial put must preserve values of fields omitted by the caller.
        yield* new Db(sql).put(notes, { id: 'n1', title: 'changed' })

        const row = yield* new Db(sql).find(notes, { id: 'n1' })
        expect(row?.title).toBe('changed')
        expect(row?.kind).toBe('note')
        expect(row?.openedAt).toBe('2026-07-29')
        expect(row?.summary).toBe('the first')
      }),
    ),
  )

  it.effect('a put naming only its key fields changes nothing', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).put(readings, { noteId: 'n1', readerId: 'r1', lastReadAt: '2026-07-29' })

        // A key only put uses DO NOTHING. The readings fixture permits insertion without
        // other values because its remaining columns are nullable or defaulted.
        yield* new Db(sql).put(readings, { noteId: 'n1', readerId: 'r1' })

        const row = yield* new Db(sql).find(readings, { noteId: 'n1', readerId: 'r1' })
        expect(row?.lastReadAt).toBe('2026-07-29')
      }),
    ),
  )

  it.effect('a put that leaves fields unchanged does not restamp them', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        // A put must retain stamps for unchanged fields so concurrent edits remain valid.
        yield* new Db(sql).put(notes, {
          id: 'n1',
          title: 'first',
          kind: 'note',
          openedAt: '2026-07-29',
          summary: 'the first',
        })
        const before = yield* changesSince(sql, {})

        yield* new Db(sql).put(notes, {
          id: 'n1',
          title: 'changed',
          kind: 'note',
          openedAt: '2026-07-29',
          summary: 'the first',
        })
        const after = yield* changesSince(sql, { cursor: before.cursor })

        // Only title changed, so only title receives a new stamp.
        const changedFields = after.changes
          .filter(c => tableOf(c) === 'notes')
          .map(c => fieldOf(c))
          .sort((x, y) => (x ?? '').localeCompare(y ?? ''))
        expect(changedFields).toEqual(['title'])
      }),
    ),
  )

  it.effect('a projection binds its parameters in splice order', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        // Check parameter ordering across projections, JOIN values, and WHERE values.
        // Incorrect ordering can bind valid values to the wrong parameters.
        const a = projectionOf(notes, {
          alias: 'a',
          coalesceDefaults: true,
          omit: ['title', 'tags', 'openedAt', 'summary', 'lastEditedAt'],
        })
        const s = projectionOf(notes, {
          alias: 's',
          coalesceDefaults: true,
          omit: ['title', 'tags', 'openedAt', 'summary', 'lastEditedAt'],
        })
        const stmt = yield* Effect.sync(
          () =>
            sql`
            SELECT
              ${a.columns},
              ${s.columns}
            FROM
              notes a
              LEFT JOIN notes s ON s.id = a.id
              AND s.title = ${'x'}
            WHERE
              a.id = ${'n1'}
          `,
        )
        const [, params] = stmt.compile()
        // Bind defaults for a, then s, then the JOIN and WHERE parameters.
        // Within each projection, defaults follow column order.
        expect(params).toEqual([0, EPOCH, 'plain', 0, 0, EPOCH, 'plain', 0, 'x', 'n1'])
      }),
    ),
  )

  it.effect(
    'a projection with coalesced defaults returns the declared default on a join miss',
    () =>
      withSql(
        Effect.fnUntraced(function* (sql) {
          // An unmatched outer join returns declared defaults for projected columns.
          yield* new Db(sql).insert(notes, { id: 'n1', title: 'first' })
          const s = projectionOf(notes, {
            alias: 's',
            coalesceDefaults: true,
            omit: ['title', 'tags', 'openedAt', 'summary', 'lastEditedAt'],
          })
          const rows = yield* sql`
          SELECT
            ${s.columns}
          FROM
            notes a
            LEFT JOIN notes s ON s.id = 'nope'
          WHERE
            a.id = ${'n1'}
        `
          expect(rows[0]?.kind).toBe('plain')
          expect(rows[0]?.pinned).toBe(0)
          expect(rows[0]?.archived).toBe(0)
        }),
      ),
  )

  it.effect('erase deletes a row that declares no framework field, physically', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(labels, { id: 'l1' })

        const result = yield* new Db(sql).transaction(tx => tx.erase(labels, { id: 'l1' }))
        expect(result.matched).toBe(true)

        // Labels has no tombstone, so erase removes the row physically.
        expect(yield* new Db(sql).find(labels, { id: 'l1' })).toBeUndefined()
      }),
    ),
  )

  it.effect('erase takes the stamp rows with it', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(labels, { id: 'l1' })
        const rowId = encodeRowId(['l1'])

        const before = yield* sql`
          SELECT
            Count(*) AS n
          FROM
            fieldStamps
          WHERE
            rowId = ${rowId}
        `
        expect((before[0] as { n: number }).n).toBeGreaterThan(0)

        yield* new Db(sql).transaction(tx => tx.erase(labels, { id: 'l1' }))

        const after = yield* sql`
          SELECT
            Count(*) AS n
          FROM
            fieldStamps
          WHERE
            rowId = ${rowId}
        `
        expect((after[0] as { n: number }).n).toBe(0)
      }),
    ),
  )

  it.effect('eraseWhere erases every row matching a filter', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(labels, { id: 'l1' })
        yield* new Db(sql).insert(labels, { id: 'l2' })

        const result = yield* new Db(sql).transaction(tx => tx.eraseWhere(labels, {}))
        expect(result.matched).toBe(2)
        expect(yield* new Db(sql).all(labels)).toEqual([])
      }),
    ),
  )

  it.effect('erase fails for an entity that declares a framework field', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(notes, { id: 'n1', title: 'first' })

        const exit = yield* Effect.exit(
          new Db(sql).transaction(tx => tx.erase(notes, { id: 'n1' })),
        )
        expect(exit._tag).toBe('Failure')
      }),
    ),
  )

  it.effect('remove fails for an entity that declares no framework field', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(labels, { id: 'l1' })

        const exit = yield* Effect.exit(new Db(sql).remove(labels, { id: 'l1' }))
        expect(exit._tag).toBe('Failure')
      }),
    ),
  )

  it.effect('an entity declaring only its keys supports insert, put, find, and eraseWhere', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(activityGroupLinks, { activityId: 'a1', groupId: 'g1' })
        expect(
          yield* new Db(sql).find(activityGroupLinks, { activityId: 'a1', groupId: 'g1' }),
        ).toEqual({ activityId: 'a1', groupId: 'g1' })

        // A key only put uses DO NOTHING because there are no columns to update.
        yield* new Db(sql).put(activityGroupLinks, { activityId: 'a1', groupId: 'g1' })

        yield* new Db(sql).insert(activityGroupLinks, { activityId: 'a2', groupId: 'g1' })
        const result = yield* new Db(sql).transaction(tx =>
          tx.eraseWhere(activityGroupLinks, { groupId: 'g1' }),
        )
        expect(result.matched).toBe(2)
        expect(yield* new Db(sql).all(activityGroupLinks)).toEqual([])
      }),
    ),
  )
})

describe('the framework fields', () => {
  it.effect('records a creation time on the write that creates the row, and settles it there', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        const db = new Db(sql)
        yield* db.insert(notes, { id: 'n1', title: 'First', summary: 'x' })
        const created = (yield* db.find(notes, { id: 'n1' }))!.createdAt

        // Store a creation time distinct from the epoch default.
        expect(created).not.toBe(EPOCH)

        // Later writes must preserve the creation time and its original stamp.
        yield* db.put(notes, { id: 'n1', title: 'Second', summary: 'x' })
        expect((yield* db.find(notes, { id: 'n1' }))!.createdAt).toEqual(created)

        const { changes } = yield* changesSince(sql, {})
        const stamped = changes.filter(c => tableOf(c) === 'notes' && fieldOf(c) === 'createdAt')
        expect(stamped.length).toBe(1)
      }),
    ),
  )

  it.effect('hides a removed row behind its deletion time and reads it back with the flag', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        const db = new Db(sql)
        yield* db.insert(notes, { id: 'n1', title: 'First', summary: 'x' })
        yield* db.remove(notes, { id: 'n1' })

        expect(yield* db.find(notes, { id: 'n1' })).toBeUndefined()
        expect(yield* db.all(notes)).toEqual([])

        // Retain the tombstoned row to reject older concurrent edits.
        // RowOf omits the tombstone but still reports the row when requested.
        const hidden = yield* db.find(notes, { id: 'n1' }, { includeDeleted: true })
        expect(hidden?.title).toBe('First')
        expect(hidden).not.toHaveProperty('deletedAt')

        const rows = yield* sql<{ readonly deletedAt: string | null }>`
          SELECT
            deletedAt
          FROM
            notes
          WHERE
            id = 'n1'
        `
        expect(rows[0].deletedAt).not.toBeNull()
      }),
    ),
  )

  it.effect('erases an entity that keeps a creation time but no tombstone', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        // A creation time without a tombstone does not prevent physical deletion.
        const db = new Db(sql)
        yield* db.insert(labels, { id: 'l1', color: 1 })
        const result = yield* db.transaction(tx => tx.erase(labels, { id: 'l1' }))
        expect(result.matched).toBe(true)
        expect(yield* db.all(labels)).toEqual([])
      }),
    ),
  )

  it.effect('refuses the delete each entity does not declare', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        const db = new Db(sql)

        // Notes requires a replicated tombstone to prevent concurrent edits from
        // restoring the row.
        yield* db.insert(notes, { id: 'n1', title: 'First', summary: 'x' })
        const erased = yield* Effect.result(db.transaction(tx => tx.erase(notes, { id: 'n1' })))
        expect(erased._tag).toBe('Failure')

        // Labels has no tombstone field for remove to write.
        yield* db.insert(labels, { id: 'l1', color: 1 })
        const removed = yield* Effect.result(db.remove(labels, { id: 'l1' }))
        expect(removed._tag).toBe('Failure')
      }),
    ),
  )

  it.effect('permits inserting a replicated row before its creation time arrives', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        // A partial incoming row must be insertable before its creation time arrives.
        // The column default has no stamp, so the replicated value replaces the default.
        yield* applyChanges(sql, [change('notes', ['n1'], 'title', 'From a peer', Hlc.new(10))])
        const before = yield* sql<{ readonly createdAt: string }>`
          SELECT
            createdAt
          FROM
            notes
          WHERE
            id = 'n1'
        `
        expect(before[0].createdAt).toBe(EPOCH)

        const created = '2020-01-01T00:00:00.000Z'
        yield* applyChanges(sql, [change('notes', ['n1'], 'createdAt', created, Hlc.new(20))])
        const after = yield* sql<{ readonly createdAt: string }>`
          SELECT
            createdAt
          FROM
            notes
          WHERE
            id = 'n1'
        `
        expect(after[0].createdAt).toBe(created)
      }),
    ),
  )
})

describe('the unique tuple', () => {
  it.effect('refuses a second live row holding a taken value', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(aliases, { id: 'a1', name: 'focus' })

        const result = yield* Effect.result(
          new Db(sql).insert(aliases, { id: 'a2', name: 'focus' }),
        )
        expect(result._tag).toBe('Failure')
        // Report a duplicate alias as a unique violation so callers can select the existing row.
        const failure = (result as { failure: { _tag: string; entity: string } }).failure
        expect(failure._tag).toBe('UniqueViolation')
        expect(failure.entity).toBe('aliases')
      }),
    ),
  )

  it.effect('frees the value the moment the row is tombstoned, with no purge', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(aliases, { id: 'a1', name: 'focus' })
        yield* new Db(sql).remove(aliases, { id: 'a1' })

        // Use a new ID because the tombstoned row retains its original key.
        // The unique value can be reused by the new row.
        yield* new Db(sql).insert(aliases, { id: 'a2', name: 'focus' })
        const row = yield* new Db(sql).findUnique(aliases, { name: 'focus' })
        expect(row?.id).toBe('a2')
      }),
    ),
  )

  it.effect('permits writing the same unique value to its current row', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(aliases, { id: 'a1', name: 'focus' })

        const { matched } = yield* new Db(sql).update(aliases, { id: 'a1' }, { name: 'focus' })
        expect(matched).toBe(true)
      }),
    ),
  )

  it.effect('refuses a rename onto a value another live row holds', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(aliases, { id: 'a1', name: 'focus' })
        yield* new Db(sql).insert(aliases, { id: 'a2', name: 'admin' })

        const exit = yield* Effect.exit(
          new Db(sql).update(aliases, { id: 'a2' }, { name: 'focus' }),
        )
        expect(exit._tag).toBe('Failure')
      }),
    ),
  )

  it.effect('leaves an edit that names no unique field alone', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(aliases, { id: 'a1', name: 'focus' })
        // Replicated duplicates must not block edits to fields outside the unique tuple.
        yield* sql.unsafe(`INSERT INTO aliases (__rowId, id, name) VALUES ('a2', 'a2', 'focus')`)

        const { matched } = yield* new Db(sql).update(aliases, { id: 'a1' }, { color: 'teal' })
        expect(matched).toBe(true)
      }),
    ),
  )

  it.effect('compares case-sensitively, because the column declares no collation', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(aliases, { id: 'a1', name: 'Focus' })
        yield* new Db(sql).insert(aliases, { id: 'a2', name: 'focus' })

        expect((yield* new Db(sql).findUnique(aliases, { name: 'Focus' }))?.id).toBe('a1')
        expect((yield* new Db(sql).findUnique(aliases, { name: 'focus' }))?.id).toBe('a2')
      }),
    ),
  )

  it.effect(
    'folds two live rows to the one with the lowest row id, the same way on every peer',
    () =>
      withSql(
        Effect.fnUntraced(function* (sql) {
          // Insert directly to represent replication, which does not enforce local tuple uniqueness.
          yield* sql.unsafe(`INSERT INTO aliases (__rowId, id, name) VALUES ('b1', 'b1', 'focus')`)
          yield* sql.unsafe(`INSERT INTO aliases (__rowId, id, name) VALUES ('a1', 'a1', 'focus')`)

          expect((yield* new Db(sql).findUnique(aliases, { name: 'focus' }))?.id).toBe('a1')
        }),
      ),
  )

  it.effect('refuses a read on an entity that declares no unique field', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        // Reject an empty unique tuple rather than selecting an arbitrary row or
        // generating invalid SQL.
        yield* new Db(sql).insert(activityGroupLinks, { activityId: 'a1', groupId: 'g1' })

        const result = yield* Effect.result(new Db(sql).findUnique(activityGroupLinks, {}))
        expect(result._tag).toBe('Failure')
        expect((result as { failure: { message: string } }).failure.message).toContain(
          'declares no unique field',
        )
      }),
    ),
  )

  it.effect('reads nothing for a value only a tombstoned row holds', () =>
    withSql(
      Effect.fnUntraced(function* (sql) {
        yield* new Db(sql).insert(aliases, { id: 'a1', name: 'focus' })
        yield* new Db(sql).remove(aliases, { id: 'a1' })

        expect(yield* new Db(sql).findUnique(aliases, { name: 'focus' })).toBeUndefined()
      }),
    ),
  )
})
