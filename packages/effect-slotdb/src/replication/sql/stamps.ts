import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import { Change, type ChangeBatch, encodeHlcColumn, Hlc, HlcColumn } from '../../changes'
import { EntityEntry, STAMPS_TABLE } from '../../migration'
import { mapStorageErrorMessage, StorageError } from '../../errors.ts'
import { clearOverflow } from './overflow.ts'

/** Stores one HLC stamp per replicated slot for comparing incoming writes. */

const HlcRow = Schema.Struct({ hlc: HlcColumn })
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(HlcRow))

export const getHlc = (
  sql: SqlClient.SqlClient,
  entityId: string,
  rowId: string,
  fieldId: string,
): Effect.Effect<Option.Option<Hlc>, StorageError> =>
  sql`
    SELECT
      hlc
    FROM
      ${sql(STAMPS_TABLE)}
    WHERE
      entityId = ${entityId}
      AND rowId = ${rowId}
      AND fieldId = ${fieldId}
    LIMIT
      1
  `.pipe(
    Effect.flatMap(decodeRows),
    Effect.map(rows => (rows.length === 0 ? Option.none() : Option.some(rows[0].hlc))),
    mapStorageErrorMessage('Failed to read a field stamp'),
  )

/**
 * Updates a slot's HLC and assigns the next local sequence number. Assigns a sequence on
 * inserts and updates so paging includes every accepted write.
 */
export const putHlc = (
  sql: SqlClient.SqlClient,
  entityId: string,
  rowId: string,
  fieldId: string,
  hlc: Hlc,
): Effect.Effect<void, StorageError> =>
  sql`
    INSERT INTO
      ${sql(STAMPS_TABLE)} (entityId, rowId, fieldId, hlc, seq)
    VALUES
      (
        ${entityId},
        ${rowId},
        ${fieldId},
        ${encodeHlcColumn(hlc)},
        (
          SELECT
            Coalesce(Max(seq), 0) + 1
          FROM
            ${sql(STAMPS_TABLE)}
        )
      )
    ON CONFLICT (entityId, rowId, fieldId) DO UPDATE
    SET
      hlc = excluded.hlc,
      seq = excluded.seq
  `.pipe(Effect.asVoid, mapStorageErrorMessage('Failed to write a field stamp'))

/**
 * Stamps changed replicated fields and returns their changes. `before` uses column result
 * keys. `after` uses field names and is encoded by the entity.
 */
export const stampChanges = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  hlc: Hlc,
  rowId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Effect.Effect<ChangeBatch, StorageError> =>
  Effect.gen(function* () {
    // Reject local fields before diffing so unchanged values cannot bypass validation.
    for (const [name] of Object.entries(after)) {
      const field = entity.fieldByName(name)
      if (field !== undefined && field.local) {
        return yield* Effect.fail(
          new StorageError({
            message: `Field "${name}" of "${entity.table}" is local and cannot be replicated`,
          }),
        )
      }
    }

    // Convert encoding errors for unknown fields into typed storage failures.
    const changed = yield* Effect.try({
      try: () => entity.encodeChanged(after, before),
      catch: cause =>
        new StorageError({
          message: `Failed to compare written and stored values for "${entity.table}"`,
          cause,
        }),
    })

    const changes: Array<Change> = []
    for (const [columnKey, value] of Object.entries(changed)) {
      const field = entity.fieldByColumnKey(columnKey)
      if (field === undefined) {
        return yield* Effect.fail(
          new StorageError({
            message: `Column "${columnKey}" of "${entity.table}" has no field to stamp`,
          }),
        )
      }
      yield* putHlc(sql, entity.id, rowId, field.id, hlc)
      changes.push(Change.make({ entityId: entity.id, rowId, fieldId: field.id, value, hlc }))
    }
    // Local writes replace stored overflow values for the changed slots.
    yield* clearOverflow(
      sql,
      entity.id,
      rowId,
      changes.map(change => change.fieldId),
    )
    return changes
  })
