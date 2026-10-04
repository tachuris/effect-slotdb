import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import { SqlClient } from 'effect/sql'
import type { EntityEntry, SchemaIndex } from '../../migration'
import type { StructFieldsOf } from '../../migration/operations.ts'
import { PEER_ROSTER_ENTITY, PeerRoster } from '../entities'
import { Db } from '../../records'
import { dieOnDuplicate, mapStorageErrorMessage, StorageError } from '../../errors'
import { HybridLogicalClock } from '../../changes'

/**
 * Manages replicated peer registrations and local progress observations. Peers
 * without observations block maintenance.
 */

/** One roster row, with whatever this peer has observed about it. */
export interface RosterEntry {
  readonly peerId: string
  readonly registeredAt: DateTime.Utc
  readonly label: string | null
  /** When this peer last heard from the peer, or null when it never has. */
  readonly lastSeenAt: DateTime.Utc | null
  /** The migration file the peer reported, or null when it has never reported one. */
  readonly chainPosition: string | null
  /**
   * The peer's pull position in this peer's stamp sequence, or null before a report.
   */
  readonly pulledThrough: number | null
}

/** The roster entity with the declared `PeerRoster` field types. */
type RosterEntity = EntityEntry<StructFieldsOf<typeof PeerRoster>>

/** Resolves the roster entity with the field types declared by `PeerRoster`. */
const rosterEntity = (index: SchemaIndex): RosterEntity =>
  index.entity(PEER_ROSTER_ENTITY) as RosterEntity

/** Registers a peer without changing an existing registration time or eviction. */
export const registerPeer = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
  peerId: string,
  accountId: string,
  registeredAt: DateTime.Utc,
): Effect.Effect<void, StorageError, HybridLogicalClock> => {
  const db = new Db(sql)
  const entity = rosterEntity(index)
  return db
    .transaction(tx =>
      Effect.gen(function* () {
        // Include evicted rows to prevent registration from changing their stamps.
        const existing = yield* db.find(entity, { peerId, accountId }, { includeDeleted: true })
        if (existing !== undefined) return
        yield* tx.insert(entity, { peerId, accountId, registeredAt })
      }),
    )
    .pipe(dieOnDuplicate)
}

/**
 * Records local observations of an active peer's reported chain and pull positions.
 * Returns whether the peer was updated. Observations do not replicate.
 */
export const observePeer = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
  peerId: string,
  accountId: string,
  seenAt: DateTime.Utc,
  chainPosition: string,
  pulledThrough: number,
): Effect.Effect<boolean, StorageError, HybridLogicalClock> => {
  const db = new Db(sql)
  const entity = rosterEntity(index)
  return Effect.gen(function* () {
    // The update reports matches under the same tombstone filter used for the write.
    const { matched } = yield* db
      .update(entity, { peerId, accountId }, { lastSeenAt: seenAt, chainPosition, pulledThrough })
      .pipe(dieOnDuplicate)
    return matched
  })
}

/** Every peer in the roster, evicted ones excluded, oldest registration first. */
export const listPeers = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
  accountId: string,
): Effect.Effect<ReadonlyArray<RosterEntry>, StorageError> =>
  Effect.gen(function* () {
    const db = new Db(sql)
    const entity = rosterEntity(index)
    const rows = yield* db.all(entity, { where: { accountId }, orderBy: 'registeredAt' })
    // The resolved entity has the field types declared by the roster schema.
    return rows
  }).pipe(mapStorageErrorMessage('Failed to list the peers'))

/**
 * Evicts a peer by writing a replicated tombstone. Returns whether an active peer
 * was evicted. Retains the row to prevent registration from undoing eviction.
 */
export const evictPeer = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
  peerId: string,
  accountId: string,
): Effect.Effect<boolean, StorageError, HybridLogicalClock> => {
  const db = new Db(sql)
  const entity = rosterEntity(index)
  return db.transaction(tx =>
    Effect.gen(function* () {
      // Include evicted rows to report known peers without undoing their eviction.
      const existing = yield* db.find(entity, { peerId, accountId }, { includeDeleted: true })
      if (existing === undefined) return false
      const { matched } = yield* tx.remove(entity, { peerId, accountId })
      return matched
    }),
  )
}

/**
 * Checks whether every active peer has reported at least the requested chain position.
 * Returns false for an empty roster or a peer without a report.
 */
export const everyPeerReached = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
  accountId: string,
  position: string,
): Effect.Effect<boolean, StorageError> =>
  listPeers(sql, index, accountId).pipe(
    Effect.map(
      entries =>
        entries.length > 0 &&
        entries.every(entry => entry.chainPosition !== null && entry.chainPosition >= position),
    ),
  )
