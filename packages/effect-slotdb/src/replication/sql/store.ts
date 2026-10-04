import type * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import type { SqlClient } from 'effect/sql'
import type { SchemaIndex } from '../../migration'
import type { StorageError } from '../../errors.ts'
import { HybridLogicalClock } from '../../changes'
import type { ChangeBatch } from '../../changes'
import { applyChanges } from './apply.ts'
import { changesSince } from './changes.ts'
import {
  evictPeer,
  everyPeerReached,
  listPeers,
  observePeer,
  registerPeer,
  type RosterEntry,
} from './peer-roster.ts'
import { purgeTombstoned, type PurgeReport } from './purge.ts'
import { getPeerSyncCursors, getOrCreatePeerId, setPeerSyncCursors } from './peer-sync-state.ts'

/**
 * A participant in a replicated dataset with a bound connection, schema index, and clock.
 * Operations require no additional services.
 */
export interface PeerStore {
  /** The last migration file in the bound schema index. */
  readonly chainPosition: string
  /** This install's peer id, generated and persisted on first use. */
  readonly getOrCreatePeerId: Effect.Effect<string, StorageError>
  readonly getPeerSyncCursors: Effect.Effect<
    { readonly pushCursor: number; readonly pullCursor: number },
    StorageError
  >
  readonly setPeerSyncCursors: (push: number, pull: number) => Effect.Effect<void, StorageError>
  /** Merges incoming changes using each field's policy. Returns accepted changes. */
  readonly applyChanges: (changes: ChangeBatch) => Effect.Effect<ChangeBatch, StorageError>
  /** Returns stamped slots after the cursor with their current values. */
  readonly changesSince: (options?: {
    readonly cursor?: number
    readonly excludeNode?: string
  }) => Effect.Effect<{ readonly changes: ChangeBatch; readonly cursor: number }, StorageError>
  /**
   * Purges deleted rows after the registered peers have received their final writes.
   * Call explicitly after checking peer progress.
   */
  readonly purgeTombstoned: (accountId: string) => Effect.Effect<PurgeReport, StorageError>
  /** Registers a peer without changing an existing registration stamp. */
  readonly registerPeer: (
    peerId: string,
    accountId: string,
    registeredAt: DateTime.Utc,
  ) => Effect.Effect<void, StorageError>
  /**
   * Records observations for a registered, active peer. Returns whether the peer was
   * updated.
   */
  readonly observePeer: (
    peerId: string,
    accountId: string,
    seenAt: DateTime.Utc,
    chainPosition: string,
    pulledThrough: number,
  ) => Effect.Effect<boolean, StorageError>
  /** The roster, evicted peers excluded, oldest registration first. */
  readonly listPeers: (accountId: string) => Effect.Effect<ReadonlyArray<RosterEntry>, StorageError>
  /** Evicts an active peer. Returns whether the peer was evicted. */
  readonly evictPeer: (peerId: string, accountId: string) => Effect.Effect<boolean, StorageError>
  /** Whether every rostered peer has been observed at or past a chain position. */
  readonly everyPeerReached: (
    accountId: string,
    position: string,
  ) => Effect.Effect<boolean, StorageError>
}

/**
 * Binds storage operations to a connection, schema index, and clock. Use `getOrCreatePeerId`
 * to read the peer ID before initializing the clock.
 */
export const makePeerStore = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
  clock: typeof HybridLogicalClock.Service,
): PeerStore => {
  const stamping = <A>(
    effect: Effect.Effect<A, StorageError, HybridLogicalClock>,
  ): Effect.Effect<A, StorageError> => Effect.provideService(effect, HybridLogicalClock, clock)

  return {
    chainPosition: index.lastMigrationFile(),
    getOrCreatePeerId: getOrCreatePeerId(sql, index),
    getPeerSyncCursors: getPeerSyncCursors(sql, index),
    setPeerSyncCursors: (push, pull) => setPeerSyncCursors(sql, index, push, pull),
    applyChanges: changes => applyChanges(sql, index, changes),
    changesSince: (options = {}) => changesSince(sql, index, options),
    purgeTombstoned: accountId => purgeTombstoned(sql, index, accountId),
    registerPeer: (peerId, accountId, registeredAt) =>
      stamping(registerPeer(sql, index, peerId, accountId, registeredAt)),
    observePeer: (peerId, accountId, seenAt, chainPosition, pulledThrough) =>
      stamping(observePeer(sql, index, peerId, accountId, seenAt, chainPosition, pulledThrough)),
    listPeers: accountId => listPeers(sql, index, accountId),
    evictPeer: (peerId, accountId) => stamping(evictPeer(sql, index, peerId, accountId)),
    everyPeerReached: (accountId, position) => everyPeerReached(sql, index, accountId, position),
  }
}

export { getOrCreatePeerId }
