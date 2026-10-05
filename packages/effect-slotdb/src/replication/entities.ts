import * as Schema from 'effect/Schema'
import { mapFields, deletedAt, immutable, key, local, withDefault } from '../migration'

/**
 * Entities used by replication operations.
 * @module
 */

/** The entity holding local peer identity and compatibility cursors. */
export const PEER_SYNC_STATE_ENTITY = 'peerSyncState'

/**
 * Local peer identity and compatibility cursors in the row addressed by id = 0.
 * Required for peer identity even when the chain includes CounterpartSyncState.
 * Singleton cursors have no counterpart identity. All fields remain local.
 */
export const PeerSyncState = Schema.Struct({
  id: key(1)(Schema.Int),
  peerId: Schema.String,
  pushCursor: withDefault(0)(Schema.Number),
  pullCursor: withDefault(0)(Schema.Number),
}).pipe(mapFields(local))

/** The entity holding sync progress for each counterpart. */
export const COUNTERPART_SYNC_STATE_ENTITY = 'counterpartSyncState'

/**
 * One local cursor row per stable counterpart dataset identity, alongside PeerSyncState.
 * Push cursors use the local sequence. Pull cursors use the counterpart's sequence.
 * Cursor fields do not replicate, and singleton progress does not initialize them.
 */
export const CounterpartSyncState = Schema.Struct({
  counterpartId: key(1)(Schema.String),
  pushCursor: withDefault(0)(Schema.Number),
  pullCursor: withDefault(0)(Schema.Number),
}).pipe(mapFields(local))

/**
 * The entity holding which peers belong to a dataset, and what this peer knows of each.
 */
export const PEER_ROSTER_ENTITY = 'peers'

/**
 * Replicated peer registrations with local progress observations. Evictions replicate
 * as tombstones. Peers without observations block maintenance.
 */
export const PeerRoster = Schema.Struct({
  // The installation ID reported during sync.
  peerId: key(1)(Schema.String),
  // An application account ID used as an opaque key.
  accountId: key(2)(Schema.String),
  // The registration time preserved for an existing peer registration.
  registeredAt: immutable(Schema.DateTimeUtcFromString),
  // The optional peer name supplied by the user.
  label: Schema.NullOr(Schema.String),
  // Local observations record progress reported to this peer.
  lastSeenAt: local(Schema.NullOr(Schema.DateTimeUtcFromString)),
  // The reported chain position used to check whether source fields can be retired.
  chainPosition: local(Schema.NullOr(Schema.String)),
  // The reported pull position in this peer's sequence used to check row purging.
  // A missing report prevents purging.
  pulledThrough: local(Schema.NullOr(Schema.Number)),
  ...deletedAt,
})
