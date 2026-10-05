import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlClient, SqlError } from 'effect/sql'
import { encodeRowId, type EntityEntry, type SchemaIndex } from '../../migration'
import { COUNTERPART_SYNC_STATE_ENTITY } from '../entities.ts'
import { mapStorageErrorMessage } from '../../errors.ts'

/** Push progress in the local sequence and pull progress in a counterpart's sequence. */
export interface SyncCursors {
  readonly pushCursor: number
  readonly pullCursor: number
}

const CursorRow = Schema.Struct({ pushCursor: Schema.Number, pullCursor: Schema.Number })
const decodeCursors = Schema.decodeUnknownEffect(Schema.Array(CursorRow))

/** Creates zero progress on first contact and reads the counterpart's stored cursors. */
export const getOrCreateCounterpartSyncCursors = Effect.fn('getOrCreateCounterpartSyncCursors')(
  function* (
    sql: SqlClient.SqlClient,
    index: SchemaIndex,
    counterpartId: string,
  ): Effect.fn.Return<SyncCursors, SqlError.SqlError | Schema.SchemaError> {
    const entity = entityOf(index)
    const counterpartColumn = entity.fieldByName('counterpartId')!.column
    yield* sql`
      INSERT OR IGNORE INTO
        ${sql(entity.table)} (__rowId, ${sql(counterpartColumn)})
      VALUES
        (
          ${encodeRowId([counterpartId])},
          ${counterpartId}
        )
    `
    const rows = yield* sql`
      SELECT
        ${sql(entity.fieldByName('pushCursor')!.column)} AS pushCursor,
        ${sql(entity.fieldByName('pullCursor')!.column)} AS pullCursor
      FROM
        ${sql(entity.table)}
      WHERE
        ${sql(counterpartColumn)} = ${counterpartId}
    `.pipe(Effect.flatMap(decodeCursors))
    return rows[0]
  },
  mapStorageErrorMessage('Failed to read counterpart sync cursors'),
)

const entityOf = (index: SchemaIndex): EntityEntry => {
  const entity = index.byName.get(COUNTERPART_SYNC_STATE_ENTITY)
  if (entity === undefined) {
    throw new Error(
      `replication: the chain declares no '${COUNTERPART_SYNC_STATE_ENTITY}' entity. ` +
        'Declare `counterpartSyncState: seed(CounterpartSyncState)` in the migration chain.',
    )
  }
  return entity
}

/** Records progress only for the counterpart that accepted the exchange. */
export const setCounterpartSyncCursors = Effect.fn('setCounterpartSyncCursors')(function* (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
  counterpartId: string,
  push: number,
  pull: number,
): Effect.fn.Return<void, SqlError.SqlError> {
  const entity = entityOf(index)
  const counterpartColumn = entity.fieldByName('counterpartId')!.column
  const pushColumn = entity.fieldByName('pushCursor')!.column
  const pullColumn = entity.fieldByName('pullCursor')!.column
  yield* sql`
      INSERT INTO
        ${sql(entity.table)} (
          __rowId,
          ${sql(counterpartColumn)},
          ${sql(pushColumn)},
          ${sql(pullColumn)}
        )
      VALUES
        (
          ${encodeRowId([counterpartId])},
          ${counterpartId},
          ${push},
          ${pull}
        )
      ON CONFLICT (${sql(counterpartColumn)}) DO UPDATE
      SET
        ${sql(pushColumn)} = ${push},
        ${sql(pullColumn)} = ${pull}
    `
}, mapStorageErrorMessage('Failed to write counterpart sync cursors'))

const PushPosition = Schema.Struct({ counterpartId: Schema.String, pushCursor: Schema.Number })
const decodePositions = Schema.decodeUnknownEffect(Schema.Array(PushPosition))

/** Reads tracked push positions when the chain includes counterpart state. */
export const getCounterpartPushPositions = Effect.fn('getCounterpartPushPositions')(function* (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
): Effect.fn.Return<
  ReadonlyArray<typeof PushPosition.Type> | undefined,
  SqlError.SqlError | Schema.SchemaError
> {
  const entity = index.byName.get(COUNTERPART_SYNC_STATE_ENTITY)
  if (entity === undefined) return undefined
  return yield* sql`
      SELECT
        ${sql(entity.fieldByName('counterpartId')!.column)} AS counterpartId,
        ${sql(entity.fieldByName('pushCursor')!.column)} AS pushCursor
      FROM
        ${sql(entity.table)}
      ORDER BY
        ${sql(entity.fieldByName('counterpartId')!.column)}
    `.pipe(Effect.flatMap(decodePositions))
}, mapStorageErrorMessage('Failed to read counterpart push positions'))
