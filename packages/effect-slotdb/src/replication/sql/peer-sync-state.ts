import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import type { EntityEntry, SchemaIndex } from '../../migration'
import { PEER_SYNC_STATE_ENTITY } from '../entities.ts'
import { mapStorageErrorMessage, StorageError } from '../../errors.ts'

/** Resolves the local peer sync state from the consuming chain. */
const entityOf = (index: SchemaIndex): EntityEntry => {
  const entity = index.byName.get(PEER_SYNC_STATE_ENTITY)
  if (entity === undefined) {
    throw new Error(
      `replication: the chain declares no '${PEER_SYNC_STATE_ENTITY}' entity. ` +
        'Declare `peerSyncState: seed(PeerSyncState)` in the migration chain.',
    )
  }
  return entity
}

const PeerRow = Schema.Struct({ peerId: Schema.String })
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(PeerRow))

const CursorRow = Schema.Struct({ pushCursor: Schema.Number, pullCursor: Schema.Number })
const decodeCursors = Schema.decodeUnknownEffect(Schema.Array(CursorRow))

const SelfRow = Schema.Struct({ peerId: Schema.String, pushCursor: Schema.Number })
const decodeSelf = Schema.decodeUnknownEffect(Schema.Array(SelfRow))

/**
 * Reads the stored peer identity and push position without creating an identity.
 * Returns undefined when the store has no peer identity.
 */
export const getSelfSyncPosition = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
): Effect.Effect<
  { readonly peerId: string; readonly pushCursor: number } | undefined,
  StorageError
> =>
  sql`
    SELECT
      ${sql(entityOf(index).fieldByName('peerId')!.column)} AS peerId,
      pushCursor
    FROM
      ${sql(entityOf(index).table)}
    WHERE
      id = 0
  `.pipe(
    Effect.flatMap(decodeSelf),
    Effect.map(rows => rows[0]),
    mapStorageErrorMessage('Failed to read the peer position'),
  )

/** Reads push progress in the local sequence and pull progress in the remote sequence. */
export const getPeerSyncCursors = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
): Effect.Effect<{ readonly pushCursor: number; readonly pullCursor: number }, StorageError> =>
  sql`
    SELECT
      pushCursor,
      pullCursor
    FROM
      ${sql(entityOf(index).table)}
    WHERE
      id = 0
  `.pipe(
    Effect.flatMap(decodeCursors),
    Effect.map(rows => rows[0] ?? { pushCursor: 0, pullCursor: 0 }),
    mapStorageErrorMessage('Failed to read sync cursors'),
  )

/** Records local push progress and remote pull progress after an exchange. */
export const setPeerSyncCursors = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
  push: number,
  pull: number,
): Effect.Effect<void, StorageError> =>
  sql`
    UPDATE ${sql(entityOf(index).table)}
    SET
      pushCursor = ${push},
      pullCursor = ${pull}
    WHERE
      id = 0
  `.pipe(Effect.asVoid, mapStorageErrorMessage('Failed to write sync cursors'))

/**
 * Reads or creates the stored peer ID. Use the ID as the clock node before calling
 * `makePeerStore`.
 */
export const getOrCreatePeerId = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
): Effect.Effect<string, StorageError> =>
  Effect.gen(function* () {
    yield* sql`
      INSERT OR IGNORE INTO
        ${sql(entityOf(index).table)} (__rowId, id, ${sql(entityOf(index).fieldByName('peerId')!.column)})
      VALUES
        ('0', 0, lower(hex(randomblob(16))))
    `
    const rows = yield* sql`
      SELECT
        ${sql(entityOf(index).fieldByName('peerId')!.column)} AS peerId
      FROM
        ${sql(entityOf(index).table)}
      WHERE
        id = 0
    `.pipe(Effect.flatMap(decodeRows))
    return rows[0].peerId
  }).pipe(mapStorageErrorMessage('Failed to read the peer id'))
