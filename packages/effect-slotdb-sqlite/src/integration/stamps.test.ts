import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { SqlClient } from 'effect/sql'
import { Hlc } from '@tachuris/effect-slotdb/changes'
import { encodeRowId } from '@tachuris/effect-slotdb/migration'
import { getHlc } from '@tachuris/effect-slotdb/replication'
import {
  FIXTURE_INDEX,
  FixtureLayer,
  entityIdFor,
  fieldIdFor,
  keyValues,
  stampChanges,
} from '../testing.ts'

describe('the column-keyed diff', () => {
  it.effect('does not restamp a retyped field whose value is unchanged', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rowId = encodeRowId(['l1'])
      const labels = FIXTURE_INDEX.entity('labels')
      const colorColumn = labels.fieldByName('color')!.column

      // Write the new column assigned by retype. The retired color column remains empty.
      yield* sql.unsafe(`INSERT INTO labels (__rowId, id, ${colorColumn}) VALUES (?, ?, ?)`, [
        rowId,
        'l1',
        7,
      ])
      const first = Hlc.new(100, 0, 'node')
      yield* stampChanges(
        sql,
        first,
        'labels',
        rowId,
        {},
        {
          ...keyValues('labels', ['l1']),
          color: 7,
        },
      )
      const stampBefore = yield* getHlc(
        sql,
        entityIdFor('labels'),
        rowId,
        fieldIdFor('labels', 'color'),
      )

      // Compare against the current stored column to avoid restamping an unchanged retyped value.
      // The original color column is retired and cannot supply the previous value.
      const stored = (yield* sql<Record<string, unknown>>`
  SELECT
    *
  FROM
    labels
  WHERE
    __rowId = ${rowId}
`)[0]
      const changes = yield* stampChanges(sql, Hlc.new(200, 0, 'node'), 'labels', rowId, stored, {
        ...keyValues('labels', ['l1']),
        color: 7,
      })
      expect(changes).toEqual([])
      const stampAfter = yield* getHlc(
        sql,
        entityIdFor('labels'),
        rowId,
        fieldIdFor('labels', 'color'),
      )
      expect(stampAfter).toEqual(stampBefore)
      expect(Option.isSome(stampAfter)).toBe(true)
    }).pipe(Effect.provide(FixtureLayer)),
  )

  it.effect('refuses a local field, which has a column and never replicates', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const result = yield* Effect.result(
        stampChanges(sql, Hlc.new(1), 'notes', encodeRowId(['n1']), {}, { openedAt: 'x' }),
      )
      expect(result._tag).toBe('Failure')
    }).pipe(Effect.provide(FixtureLayer)),
  )
})
