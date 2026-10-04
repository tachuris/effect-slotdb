import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import { mapStorageErrorMessage, StorageError } from '../../errors.ts'
import type { EntityEntry } from '../entries.ts'
import type { SchemaIndex } from '../schema-index.ts'
import { OVERFLOW_TABLE } from './tables.ts'
import { decodeRowId } from '../entries.ts'
import { EntityId, FieldId } from '../ids.ts'

const OverflowRow = Schema.Struct({
  entityId: EntityId,
  rowId: Schema.String,
  fieldId: FieldId,
  value: Schema.NullOr(Schema.String),
})
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(OverflowRow))

/**
 * Drains known overflow values into stored columns on every startup. Preserves existing
 * stamps so returning from an older build recovers the latest accepted values.
 */
export const drainOverflow = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
): Effect.Effect<number, StorageError> =>
  Effect.gen(function* () {
    const rows = yield* sql`
      SELECT
        entityId,
        rowId,
        fieldId,
        value
      FROM
        ${sql(OVERFLOW_TABLE)}
    `.pipe(Effect.flatMap(decodeRows))

    // Group columns by row so draining can create rows whose fields were all unknown.
    const byRow = new Map<string, Array<(typeof rows)[number]>>()
    for (const row of rows) {
      const key = `${row.entityId}|${row.rowId}`
      const group = byRow.get(key)
      if (group === undefined) byRow.set(key, [row])
      else group.push(row)
    }

    let drained = 0
    for (const group of byRow.values()) {
      const entity = index.entities.get(group[0].entityId)
      if (entity === undefined) continue

      const placeable = group.filter(row => {
        const field = entity.fieldsById.get(row.fieldId)
        return field !== undefined && !field.local
      })
      // Retain unknown values in overflow for later relay.
      if (placeable.length === 0) continue

      const columns = Object.fromEntries(
        placeable.map(row => [
          entity.fieldsById.get(row.fieldId)!.column,
          row.value === null ? null : (JSON.parse(row.value) as unknown),
        ]),
      )

      const written = yield* writeDrained(sql, entity, group[0].rowId, columns)
      // Defer rows with unknown required columns until the schema supports those columns.
      if (!written) continue

      for (const row of placeable) {
        yield* sql`
          DELETE FROM ${sql(OVERFLOW_TABLE)}
          WHERE
            entityId = ${row.entityId}
            AND rowId = ${row.rowId}
            AND fieldId = ${row.fieldId}
        `
        drained += 1
      }
    }
    return drained
  }).pipe(mapStorageErrorMessage('Failed to drain the overflow'))

/** Put the drained columns on the row, creating the row when it does not exist yet. */
const writeDrained = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  rowId: string,
  columns: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const present = yield* sql`
      SELECT
        1 AS one
      FROM
        ${sql(entity.table)}
      WHERE
        __rowId = ${rowId}
      LIMIT
        1
    `
    const write =
      present.length > 0
        ? sql`
            UPDATE ${sql(entity.table)}
            SET
              ${sql.update(columns)}
            WHERE
              __rowId = ${rowId}
          `
        : sql`
            INSERT INTO
              ${sql(entity.table)} ${sql.insert({
                __rowId: rowId,
                ...entity.keyColumnValues(decodeRowId(rowId)),
                ...columns,
              })}
          `
    const result = yield* Effect.result(write)
    return result._tag === 'Success'
  })
