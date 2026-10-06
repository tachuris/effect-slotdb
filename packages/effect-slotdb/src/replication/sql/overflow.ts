import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import { mapStorageErrorMessage, StorageError } from '../../errors.ts'
import { FieldId, OVERFLOW_TABLE } from '../../migration'
import type { Change } from '../../changes'

const OverflowRow = Schema.Struct({ value: Schema.NullOr(Schema.String) })
const decodeOverflowRows = Schema.decodeUnknownEffect(Schema.Array(OverflowRow))

const PendingRow = Schema.Struct({ fieldId: FieldId, value: Schema.NullOr(Schema.String) })
const decodePendingRows = Schema.decodeUnknownEffect(Schema.Array(PendingRow))

/** A row slot's value stored in overflow. */
export interface PendingSlot {
  readonly fieldId: FieldId
  readonly value: unknown
}

/**
 * Reads a slot value from overflow, or returns undefined when no value is stored.
 */
export const overflowValue = (
  sql: SqlClient.SqlClient,
  entityId: string,
  rowId: string,
  fieldId: string,
): Effect.Effect<unknown, StorageError> =>
  sql`
    SELECT
      value
    FROM
      ${sql(OVERFLOW_TABLE)}
    WHERE
      entityId = ${entityId}
      AND rowId = ${rowId}
      AND fieldId = ${fieldId}
    LIMIT
      1
  `.pipe(
    Effect.flatMap(decodeOverflowRows),
    Effect.map(rows =>
      rows.length === 0 || rows[0].value === null ? undefined : JSON.parse(rows[0].value),
    ),
    mapStorageErrorMessage('Failed to read an overflow value'),
  )

/** Reads all slot values stored in overflow for a row. */
export const overflowSlots = (
  sql: SqlClient.SqlClient,
  entityId: string,
  rowId: string,
): Effect.Effect<ReadonlyArray<PendingSlot>, StorageError> =>
  sql`
    SELECT
      fieldId,
      value
    FROM
      ${sql(OVERFLOW_TABLE)}
    WHERE
      entityId = ${entityId}
      AND rowId = ${rowId}
  `.pipe(
    Effect.flatMap(decodePendingRows),
    Effect.map(rows =>
      rows.map(row => ({
        fieldId: row.fieldId,
        value: row.value === null ? null : (JSON.parse(row.value) as unknown),
      })),
    ),
    mapStorageErrorMessage('Failed to read overflow values'),
  )

/** Stores a change's value in overflow and replaces any existing value for the slot. */
export const writeOverflow = (
  sql: SqlClient.SqlClient,
  change: Change,
): Effect.Effect<void, StorageError> =>
  sql`
    INSERT INTO
      ${sql(OVERFLOW_TABLE)} ${sql.insert({
        entityId: change.entityId,
        rowId: change.rowId,
        fieldId: change.fieldId,
        value: JSON.stringify(change.value ?? null),
      })}
    ON CONFLICT (entityId, rowId, fieldId) DO UPDATE
    SET
      value = excluded.value
  `.pipe(Effect.asVoid, mapStorageErrorMessage('Failed to store an overflow value'))

/** Deletes overflow values for the specified slots of a row. */
export const clearOverflow = (
  sql: SqlClient.SqlClient,
  entityId: string,
  rowId: string,
  fieldIds: ReadonlyArray<string>,
): Effect.Effect<void, StorageError> =>
  fieldIds.length === 0
    ? Effect.void
    : sql`
        DELETE FROM ${sql(OVERFLOW_TABLE)}
        WHERE
          entityId = ${entityId}
          AND rowId = ${rowId}
          AND ${sql.in('fieldId', fieldIds)}
      `.pipe(Effect.asVoid, mapStorageErrorMessage('Failed to clear overflow values'))
