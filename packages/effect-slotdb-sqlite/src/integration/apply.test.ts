import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Logger from 'effect/Logger'
import { SqlClient } from 'effect/sql'
import { Change, Hlc } from '@tachuris/effect-slotdb/changes'
import {
  DEAD_LETTER_TABLE,
  EntityId,
  FieldId,
  OVERFLOW_TABLE,
} from '@tachuris/effect-slotdb/migration'
import { encodeRowId } from '@tachuris/effect-slotdb/migration'
import { Db } from '@tachuris/effect-slotdb/records'
import { FIXTURE_INDEX } from '@tachuris/effect-slotdb/testing'
import { FixtureLayer, applyChanges, change, changesSince, entityIdFor } from '../testing.ts'

/** An unknown field ID representing a field declared by a newer peer. */
const UNKNOWN_FIELD = FieldId.make('ffffffffffffffff')
const UNKNOWN_ENTITY = EntityId.make('eeeeeeeeeeeeeeee')

const bornLater = (rowId: string, value: unknown, hlc: Hlc): Change =>
  Change.make({
    entityId: entityIdFor('notes'),
    rowId,
    fieldId: UNKNOWN_FIELD,
    value,
    hlc,
  })

describe('a field this build has no column for', () => {
  it.effect('is stored and relayed on push', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rowId = encodeRowId(['a1'])
      yield* applyChanges(sql, [
        change('notes', ['a1'], 'title', 'Reading', Hlc.new(10)),
        bornLater(rowId, 'a value from the future', Hlc.new(11)),
      ])

      const stored = yield* sql`
        SELECT
          value
        FROM
          ${sql(OVERFLOW_TABLE)}
        WHERE
          fieldId = ${UNKNOWN_FIELD}
      `
      expect(stored).toHaveLength(1)

      // Relay unknown fields so older peers preserve data from newer peers.
      const { changes } = yield* changesSince(sql, {})
      const relayed = changes.filter(c => c.fieldId === UNKNOWN_FIELD)
      expect(relayed).toHaveLength(1)
      expect(relayed[0].value).toBe('a value from the future')
    }).pipe(Effect.provide(FixtureLayer)),
  )

  it.effect('is excluded from application reads', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rowId = encodeRowId(['a1'])
      yield* applyChanges(sql, [
        change('notes', ['a1'], 'title', 'Reading', Hlc.new(10)),
        bornLater(rowId, 'invisible', Hlc.new(11)),
      ])

      const rows = yield* sql<Record<string, unknown>>`
        SELECT
          *
        FROM
          notes
        WHERE
          __rowId = ${rowId}
      `
      expect(Object.values(rows[0])).not.toContain('invisible')
    }).pipe(Effect.provide(FixtureLayer)),
  )

  it.effect('remains after reading and updating a known field', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rowId = encodeRowId(['a1'])
      yield* applyChanges(sql, [
        change('notes', ['a1'], 'title', 'Reading', Hlc.new(10)),
        bornLater(rowId, 'kept', Hlc.new(11)),
      ])

      // Editing a known field must preserve unknown fields received from a newer peer.
      yield* applyChanges(sql, [change('notes', ['a1'], 'title', 'Rewritten', Hlc.new(20))])

      const { changes } = yield* changesSince(sql, {})
      expect(changes.find(c => c.fieldId === UNKNOWN_FIELD)?.value).toBe('kept')
    }).pipe(Effect.provide(FixtureLayer)),
  )

  it.effect('stores and relays fields of an unknown entity', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyChanges(sql, [
        Change.make({
          entityId: UNKNOWN_ENTITY,
          rowId: 'r1',
          fieldId: UNKNOWN_FIELD,
          value: 42,
          hlc: Hlc.new(10),
        }),
      ])

      const { changes } = yield* changesSince(sql, {})
      expect(changes.find(c => c.entityId === UNKNOWN_ENTITY)?.value).toBe(42)
    }).pipe(Effect.provide(FixtureLayer)),
  )

  it.effect('retains the value with the latest stamp', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rowId = encodeRowId(['a1'])
      yield* applyChanges(sql, [change('notes', ['a1'], 'title', 'Reading', Hlc.new(10))])
      yield* applyChanges(sql, [bornLater(rowId, 'older', Hlc.new(11))])
      yield* applyChanges(sql, [bornLater(rowId, 'newer', Hlc.new(12))])
      yield* applyChanges(sql, [bornLater(rowId, 'stale', Hlc.new(5))])

      const { changes } = yield* changesSince(sql, {})
      expect(changes.find(c => c.fieldId === UNKNOWN_FIELD)?.value).toBe('newer')
    }).pipe(Effect.provide(FixtureLayer)),
  )
})

describe('a value that fails decoding', () => {
  it.effect('is recorded as a dead letter without updating the row or stamp', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyChanges(sql, [change('notes', ['a1'], 'title', 'Reading', Hlc.new(10))])

      // Reject values outside the pinned field's literal schema.
      yield* applyChanges(sql, [change('notes', ['a1'], 'pinned', 'not-a-bit', Hlc.new(20))])

      const dead = yield* sql`
        SELECT
          fieldId
        FROM
          ${sql(DEAD_LETTER_TABLE)}
      `
      expect(dead).toHaveLength(1)

      const rows = yield* sql<{ readonly pinned: number }>`
        SELECT
          pinned
        FROM
          notes
        WHERE
          __rowId = ${encodeRowId(['a1'])}
      `
      expect(rows[0].pinned).not.toBe('not-a-bit')

      // Invalid values remain unstamped because the store has not accepted the write.
      const { changes } = yield* changesSince(sql, {})
      expect(changes.some(c => c.value === 'not-a-bit')).toBe(false)
    }).pipe(Effect.provide(FixtureLayer)),
  )
})

describe('an undeclared member of an open literal union', () => {
  it.effect('is stored, stamped, and relayed', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyChanges(sql, [change('signals', ['s1'], 'level', 'critical', Hlc.new(10))])

      const rows = yield* sql<{ readonly level: string }>`
        SELECT
          level
        FROM
          signals
        WHERE
          __rowId = ${encodeRowId(['s1'])}
      `
      expect(rows[0].level).toBe('critical')

      const { changes } = yield* changesSince(sql, {})
      expect(changes.some(c => c.value === 'critical')).toBe(true)
    }).pipe(Effect.provide(FixtureLayer)),
  )

  it.effect('logs an undeclared member only when the stored value changes', () =>
    Effect.gen(function* () {
      const messages: Array<string> = []
      const capture = Logger.make(options => {
        messages.push(JSON.stringify(options.message))
      })
      const sql = yield* SqlClient.SqlClient

      yield* applyChanges(sql, [
        change('signals', ['s1'], 'level', 'low', Hlc.new(10)),
        change('signals', ['s2'], 'level', 'critical', Hlc.new(11)),
      ]).pipe(Effect.provide(Logger.layer([capture])))
      // A stamp update without a value change does not produce another log.
      yield* applyChanges(sql, [change('signals', ['s2'], 'level', 'critical', Hlc.new(12))]).pipe(
        Effect.provide(Logger.layer([capture])),
      )

      expect(messages.filter(m => m.includes('sync.unrecognized_member'))).toHaveLength(1)
    }).pipe(Effect.provide(FixtureLayer)),
  )

  it.effect('is recorded as a dead letter when the storage check fails', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* applyChanges(sql, [change('signals', ['s1'], 'level', '', Hlc.new(10))])

      const dead = yield* sql`
        SELECT
          fieldId
        FROM
          ${sql(DEAD_LETTER_TABLE)}
      `
      expect(dead).toHaveLength(1)
    }).pipe(Effect.provide(FixtureLayer)),
  )
})

describe('a unique tuple shared by two peers', () => {
  it.effect('applies both rows without enforcing tuple uniqueness', () =>
    Effect.gen(function* () {
      // Accept both offline aliases with the same unique value so replication can
      // continue.
      const sql = yield* SqlClient.SqlClient
      yield* applyChanges(sql, [
        change('aliases', ['b1'], 'name', 'focus', Hlc.new(10)),
        change('aliases', ['a1'], 'name', 'focus', Hlc.new(11)),
      ])

      const rows = yield* sql`
        SELECT
          __rowId
        FROM
          aliases
        WHERE
          name = 'focus'
      `
      expect(rows).toHaveLength(2)
    }).pipe(Effect.provide(FixtureLayer)),
  )

  it.effect('selects the row with the lowest row ID when reading by the tuple', () =>
    Effect.gen(function* () {
      // Peers with the same duplicate rows must select the same alias when reading by the
      // unique tuple.
      const sql = yield* SqlClient.SqlClient
      yield* applyChanges(sql, [
        change('aliases', ['b1'], 'name', 'focus', Hlc.new(10)),
        change('aliases', ['a1'], 'name', 'focus', Hlc.new(11)),
      ])

      const found = yield* new Db(sql).findUnique(FIXTURE_INDEX.typed.aliases, { name: 'focus' })
      expect(found?.id).toBe('a1')
    }).pipe(Effect.provide(FixtureLayer)),
  )
})
