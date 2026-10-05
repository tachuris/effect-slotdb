import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import type { EntityEntry, SchemaIndex } from '../../migration'
import { DEAD_LETTER_TABLE, OVERFLOW_TABLE, STAMPS_TABLE } from '../../migration'
import { listPeers } from './peer-roster.ts'
import { PEER_ROSTER_ENTITY } from '../entities.ts'
import { mapStorageErrorMessage, StorageError } from '../../errors.ts'
import { getCounterpartPushPositions } from './counterpart-sync-state.ts'
import { getSelfSyncPosition } from './peer-sync-state.ts'

/** Counts removed and retained rows and identifies peers blocking removal. */
export interface PurgeReport {
  /** Rows physically removed, across every entity. */
  readonly purged: number
  /** Tombstoned rows left in place, because a peer may not have the tombstone yet. */
  readonly retained: number
  /**
   * Other peers whose reported positions do not cover a retained row. Peers without
   * observations block removal until observed or evicted.
   */
  readonly blockedBy: ReadonlyArray<string>
  /** Counterparts missing retained deletions. Omitted for singleton cursor chains. */
  readonly blockedCounterparts?: ReadonlyArray<string>
  /** Whether unpushed writes on this peer prevent row removal. */
  readonly selfBehind: boolean
  /** The number of registered peers. An empty roster prevents removal. */
  readonly rosterSize: number
}

const RowSeq = Schema.Struct({ rowId: Schema.String, seq: Schema.Number })
const decodeRowSeqs = Schema.decodeUnknownEffect(Schema.Array(RowSeq))

/**
 * Purges tombstoned rows after all registered peers have received their final writes.
 * Unpushed local writes prevent removal. Call explicitly after checking peer progress.
 */
export const purgeTombstoned = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
  accountId: string,
): Effect.Effect<PurgeReport, StorageError> =>
  Effect.gen(function* () {
    const roster = yield* listPeers(sql, index, accountId)
    const self = yield* getSelfSyncPosition(sql, index)
    const counterparts = yield* getCounterpartPushPositions(sql, index)
    const pushPosition =
      counterparts === undefined
        ? (self?.pushCursor ?? 0)
        : counterparts.length === 0
          ? 0
          : Math.min(...counterparts.map(c => c.pushCursor))
    const rosterEntityId = index.entity(PEER_ROSTER_ENTITY).id

    // Compare remote pull positions and the local push position in this store's sequence.
    // Unpushed local tombstones must remain until another peer receives the deletion.
    const positions = roster.map(entry => ({
      peerId: entry.peerId,
      position: entry.peerId === self?.peerId ? pushPosition : entry.pulledThrough,
    }))

    const watermark =
      positions.length === 0 || positions.some(p => p.position === null)
        ? -1
        : Math.min(
            ...positions.map(p => p.position!),
            ...(counterparts === undefined ? [] : [pushPosition]),
          )

    let purged = 0
    let retained = 0
    let highestRetained = -1

    for (const entity of index.entities.values()) {
      // Retain evicted peer rows so registration cannot undo an eviction.
      // Other peers may still have the eviction tombstone.
      if (entity.id === rosterEntityId) continue

      const candidates = yield* tombstonedRows(sql, entity)
      for (const { rowId, seq } of candidates) {
        if (seq <= watermark) {
          yield* removeRow(sql, entity, rowId)
          purged += 1
        } else {
          retained += 1
          highestRetained = Math.max(highestRetained, seq)
        }
      }
    }

    // Report blocking peers only when rows remain.
    const behind =
      retained === 0
        ? []
        : positions.filter(p => p.position === null || p.position < highestRetained)

    return {
      purged,
      retained,
      blockedBy: behind.filter(p => p.peerId !== self?.peerId).map(p => p.peerId),
      selfBehind:
        behind.some(p => p.peerId === self?.peerId) ||
        (retained > 0 && counterparts !== undefined && pushPosition < highestRetained),
      ...(counterparts === undefined
        ? {}
        : {
            blockedCounterparts:
              retained === 0
                ? []
                : counterparts
                    .filter(c => c.pushCursor < highestRetained)
                    .map(c => c.counterpartId),
          }),
      rosterSize: roster.length,
    }
  }).pipe(sql.withTransaction, mapStorageErrorMessage('Failed to purge tombstoned rows'))

/**
 * Lists tombstoned rows with their latest slot sequence. Excludes unstamped tombstones
 * because peer progress cannot confirm receipt.
 */
const tombstonedRows = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
): Effect.Effect<ReadonlyArray<typeof RowSeq.Type>, StorageError> => {
  const tombstone = entity.tombstoneField
  if (tombstone === undefined) return Effect.succeed([])
  return sql`
    SELECT
      tomb.rowId,
      Max(allSlots.seq) AS seq
    FROM
      ${sql(STAMPS_TABLE)} AS tomb
      JOIN ${sql(entity.table)} AS stored ON stored.__rowId = tomb.rowId
      JOIN ${sql(STAMPS_TABLE)} AS allSlots ON allSlots.entityId = tomb.entityId
      AND allSlots.rowId = tomb.rowId
    WHERE
      tomb.entityId = ${entity.id}
      AND tomb.fieldId = ${tombstone.id}
      AND ${sql.literal(`stored.${tombstone.column}`)} IS NOT NULL
    GROUP BY
      tomb.rowId
  `.pipe(Effect.flatMap(decodeRowSeqs), mapStorageErrorMessage('Failed to list tombstoned rows'))
}

/**
 * Deletes a row and its stamps, overflow values, and dead letters. Removing overflow
 * prevents the drain from recreating the row.
 */
const removeRow = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  rowId: string,
): Effect.Effect<void, StorageError> =>
  Effect.gen(function* () {
    yield* sql`
      DELETE FROM ${sql(entity.table)}
      WHERE
        __rowId = ${rowId}
    `
    for (const table of [STAMPS_TABLE, OVERFLOW_TABLE, DEAD_LETTER_TABLE]) {
      yield* sql`
        DELETE FROM ${sql(table)}
        WHERE
          entityId = ${entity.id}
          AND rowId = ${rowId}
      `
    }
  }).pipe(Effect.asVoid, mapStorageErrorMessage('Failed to remove a row'))
