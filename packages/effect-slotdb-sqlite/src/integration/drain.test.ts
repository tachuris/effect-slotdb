import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { SqlClient } from 'effect/sql'
import { Change, Hlc } from '@tachuris/effect-slotdb/changes'
import { FieldId, SchemaIndex, encodeRowId } from '@tachuris/effect-slotdb/migration'
import { getHlc } from '@tachuris/effect-slotdb/replication'
import {
  FIXTURE_INDEX,
  FixtureLayer,
  TEST_ACCOUNT,
  applyChanges,
  boundTo,
  change,
  changesSince,
  drainOverflow,
  entityIdFor,
  fieldIdFor,
} from '../testing.ts'

/** A chain prefix without `notes.summary` representing an older peer. */
const withoutNotes = new SchemaIndex(FIXTURE_INDEX.chain.slice(0, 2))

describe('draining the overflow', () => {
  it.effect('moves a value into its column once this build knows the field', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rowId = encodeRowId(['a1'])
      yield* applyChanges(sql, [
        change('notes', ['a1'], 'title', 'Reading', Hlc.new(10)),
        change('notes', ['a1'], 'kind', 'once', Hlc.new(10)),
      ])

      // An older build stores the unknown title value in overflow.
      yield* applyChangesAsOlderBuild(sql, rowId)
      expect(yield* notesOf(sql, rowId)).toBeNull()

      const drained = yield* drainOverflow(sql)
      expect(drained).toBe(1)
      expect(yield* notesOf(sql, rowId)).toBe('From a newer peer')
    }).pipe(Effect.provide(FixtureLayer)),
  )

  it.effect('moves no stamp, so the slot is not re-offered as a fresh write', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rowId = encodeRowId(['a1'])
      yield* applyChanges(sql, [
        change('notes', ['a1'], 'title', 'Reading', Hlc.new(10)),
        change('notes', ['a1'], 'kind', 'once', Hlc.new(10)),
      ])
      yield* applyChangesAsOlderBuild(sql, rowId)

      const before = yield* stampOfNotes(sql, rowId)
      yield* drainOverflow(sql)
      const after = yield* stampOfNotes(sql, rowId)

      // Draining must retain the stamp assigned when the incoming value was accepted.
      expect(after).toEqual(before)
    }).pipe(Effect.provide(FixtureLayer)),
  )

  it.effect('recovers the newer value after a downgrade and a return', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rowId = encodeRowId(['a1'])

      // The newer build has the field and a value in the column.
      yield* applyChanges(sql, [
        change('notes', ['a1'], 'title', 'Reading', Hlc.new(10)),
        change('notes', ['a1'], 'kind', 'once', Hlc.new(10)),
        change('notes', ['a1'], 'summary', 'stale', Hlc.new(10)),
      ])

      // An older build receives a new unknown value while the newer column retains its
      // old value.
      yield* applyChangesAsOlderBuild(sql, rowId)
      expect(yield* notesOf(sql, rowId)).toBe('stale')

      // Starting the newer build drains the latest overflow value into its column.
      yield* drainOverflow(sql)
      expect(yield* notesOf(sql, rowId)).toBe('From a newer peer')
    }).pipe(Effect.provide(FixtureLayer)),
  )

  it.effect('leaves a value it still does not understand where it is', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rowId = encodeRowId(['a1'])
      yield* applyChanges(sql, [
        change('notes', ['a1'], 'title', 'Reading', Hlc.new(10)),
        change('notes', ['a1'], 'kind', 'once', Hlc.new(10)),
      ])
      yield* applyChanges(sql, [
        Change.make({
          entityId: entityIdFor('notes'),
          rowId,
          fieldId: FieldId.make('ffffffffffffffff'),
          value: 'still unknown',
          hlc: Hlc.new(11),
        }),
      ])

      expect(yield* drainOverflow(sql)).toBe(0)

      // Retain unknown values for relay to peers that understand the field.
      const { changes } = yield* changesSince(sql, {})
      expect(changes.find(c => c.fieldId === 'ffffffffffffffff')?.value).toBe('still unknown')
    }).pipe(Effect.provide(FixtureLayer)),
  )
})

/** An apply run by a build with no `title` column, which sends the value to overflow. */
const applyChangesAsOlderBuild = (sql: SqlClient.SqlClient, rowId: string) =>
  boundTo(withoutNotes).applyChanges(sql, [
    Change.make({
      entityId: entityIdFor('notes'),
      rowId,
      fieldId: fieldIdFor('notes', 'summary'),
      value: 'From a newer peer',
      hlc: Hlc.new(20),
    }),
  ])

const notesOf = (sql: SqlClient.SqlClient, rowId: string) =>
  sql<{ readonly summary: string | null }>`
    SELECT
      summary
    FROM
      notes
    WHERE
      __rowId = ${rowId}
  `.pipe(Effect.map(rows => rows[0]?.summary ?? null))

const stampOfNotes = (sql: SqlClient.SqlClient, rowId: string) =>
  getHlc(sql, entityIdFor('notes'), rowId, fieldIdFor('notes', 'summary')).pipe(
    Effect.map(Option.getOrNull),
  )

describe('two peers built from different chain prefixes', () => {
  /** A chain prefix without the `peers` entity. */
  const older = new SchemaIndex(FIXTURE_INDEX.chain.slice(0, 1))

  it.effect('exchange in both directions with nothing refused', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      // An older peer must accept the unknown roster entity for relay to newer peers.
      const fromNewer = [
        change(
          'peers',
          ['laptop', TEST_ACCOUNT],
          'registeredAt',
          '2026-07-20T09:00:00.000Z',
          Hlc.new(10),
        ),
      ]
      const applied = yield* boundTo(older).applyChanges(sql, fromNewer)
      expect(applied).toHaveLength(1)

      // The older peer must include the unknown roster fields in its outgoing changes.
      const { changes } = yield* boundTo(older).changesSince(sql, {})
      expect(changes.map(c => c.entityId)).toContain(fromNewer[0].entityId)

      // The newer schema resolves the relayed field to a stored column.
      yield* drainOverflow(sql)
      const rows = yield* sql<{ readonly registeredAt: string }>`
        SELECT
          registeredAt
        FROM
          peers
      `
      expect(rows[0]?.registeredAt).toBe('2026-07-20T09:00:00.000Z')
    }).pipe(Effect.provide(FixtureLayer)),
  )
})
