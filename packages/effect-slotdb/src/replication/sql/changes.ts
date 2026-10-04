import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import { mapStorageErrorMessage, StorageError } from '../../errors.ts'
import type { SchemaIndex } from '../../migration'
import { EntityId, FieldId, OVERFLOW_TABLE, STAMPS_TABLE } from '../../migration'
import { Change, type ChangeBatch, HlcColumn } from '../../changes'

const StampRow = Schema.Struct({
  entityId: EntityId,
  rowId: Schema.String,
  fieldId: FieldId,
  hlc: HlcColumn,
  seq: Schema.Number,
})
const decodeStampRows = Schema.decodeUnknownEffect(Schema.Array(StampRow))

const OverflowRow = Schema.Struct({ value: Schema.NullOr(Schema.String) })
const decodeOverflowRows = Schema.decodeUnknownEffect(Schema.Array(OverflowRow))

/**
 * Returns stamped slots after the cursor, including unknown fields stored in overflow.
 * The next cursor advances past scanned slots, including excluded stamps.
 */
export const changesSince = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
  options: { readonly cursor?: number; readonly excludeNode?: string } = {},
): Effect.Effect<{ readonly changes: ChangeBatch; readonly cursor: number }, StorageError> =>
  Effect.gen(function* () {
    const from = options.cursor ?? 0
    // Page by local sequence so a late incoming merge is included regardless of HLC
    // order.
    const stamps = yield* sql`
      SELECT
        entityId,
        rowId,
        fieldId,
        hlc,
        seq
      FROM
        ${sql(STAMPS_TABLE)}
      WHERE
        seq > ${from}
      ORDER BY
        seq
    `.pipe(Effect.flatMap(decodeStampRows))

    const changes: Array<Change> = []
    let cursor = from
    for (const stamp of stamps) {
      cursor = stamp.seq
      if (options.excludeNode !== undefined && stamp.hlc.node === options.excludeNode) {
        // Exclude the requesting peer's writes from its outgoing page.
        continue
      }
      const base = {
        entityId: stamp.entityId,
        rowId: stamp.rowId,
        fieldId: stamp.fieldId,
        hlc: stamp.hlc,
      }

      const entity = index.entities.get(stamp.entityId)
      const field = entity?.fieldsById.get(stamp.fieldId)

      if (entity === undefined || field === undefined) {
        // Relay unknown fields from overflow to preserve data from newer peers.
        const stored = yield* overflowValue(sql, stamp.entityId, stamp.rowId, stamp.fieldId)
        if (stored !== undefined) changes.push(Change.make({ ...base, value: stored }))
        continue
      }

      // A stamp on a local field indicates corrupt metadata because local writes do not
      // replicate.
      if (field.local) continue

      const rows = yield* sql<Record<string, unknown>>`
        SELECT
          *
        FROM
          ${sql(entity.table)}
        WHERE
          __rowId = ${stamp.rowId}
        LIMIT
          1
      `
      if (rows.length === 0) continue
      changes.push(Change.make({ ...base, value: rows[0][field.column] ?? null }))
    }
    return { changes, cursor }
  }).pipe(mapStorageErrorMessage('Failed to read changes since the cursor'))

/** Reads a JSON value from overflow for a field without a known column. */
const overflowValue = (
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
