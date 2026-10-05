import * as Schema from 'effect/Schema'
import type { SqlClient } from 'effect/sql'
import type { Hlc } from './changes'
import {
  createdAt,
  deletedAt,
  growOnly,
  highWater,
  key,
  latch,
  local,
  unique,
  withDefault,
  seed,
  migrateSchema,
  retype,
} from './migration'
import * as migration from './migration'
import * as replication from './replication'
// Fixtures use operations with a connection argument to test different chain prefixes.
import * as apply from './replication/sql/apply.ts'
import * as changes from './replication/sql/changes.ts'
import * as roster from './replication/sql/peer-roster.ts'
import * as purge from './replication/sql/purge.ts'
import * as counterpartSyncState from './replication/sql/counterpart-sync-state.ts'
import * as peerSyncState from './replication/sql/peer-sync-state.ts'

const migration0000 = migration.SchemaIndex.seed({
  file: '0000',
  name: 'support',
  entities: {
    peers: seed(replication.PeerRoster),
    peerSyncState: seed(replication.PeerSyncState),
  },
})

const migration0001 = migration0000.appendMigration({
  file: '0001',
  name: 'domain',
  entities: {
    // Tests defaults, boolean merging, set union, and framework fields with a single key.
    notes: seed(
      Schema.Struct({
        id: key(1)(Schema.String),
        title: Schema.String,
        kind: withDefault('plain')(Schema.String),
        pinned: withDefault(0)(Schema.BooleanFromBit),
        archived: withDefault(0)(latch(Schema.BooleanFromBit)),
        tags: growOnly(Schema.NullOr(Schema.String)),
        // Stored locally without replication.
        openedAt: local(Schema.NullOr(Schema.String)),
        ...deletedAt,
        ...createdAt,
      }),
    ),
    // Tests a composite key, a nullable maximum value, and deletion without creation time.
    readings: seed(
      Schema.Struct({
        noteId: key(1)(Schema.String),
        readerId: key(2)(Schema.String),
        lastReadAt: highWater(Schema.NullOr(Schema.String)),
        ...deletedAt,
      }),
    ),
  },
})

const migration0002 = migration0001.appendMigration({
  file: '0002',
  name: 'later',
  entities: {
    // Tests adding a column to an existing table.
    notes: migrateSchema(
      migration0001.schemas.notes,
      migration.addOptional('summary', Schema.String),
    ),
  },
})

// Tests a stored type change with a new ID and suffixed column.
const migration0003 = migration0002.appendMigration({
  file: '0003',
  name: 'retype',
  entities: {
    labels: seed(
      Schema.Struct({
        id: key(1)(Schema.String),
        color: Schema.NullOr(Schema.String),
        ...createdAt,
      }),
    ),
  },
})

const migration0004 = migration0003.appendMigration({
  file: '0004',
  name: 'retype',
  entities: {
    labels: migrateSchema(
      migration0003.schemas.labels,
      retype('color', Schema.NullOr(Schema.Number)),
    ),
  },
})

const migration0005 = migration0004.appendMigration({
  file: '0005',
  name: 'wrapped-local',
  entities: {
    // Optional wrappers must preserve field markers.
    notes: migrateSchema(
      migration0004.schemas.notes,
      migration.addOptional('lastEditedAt', local(Schema.NullOr(Schema.DateTimeUtcFromString))),
    ),
  },
})

const migration0006 = migration0005.appendMigration({
  file: '0006',
  name: 'all-key',
  entities: {
    // Tests derivation, model fields, and DDL for an entity containing only key fields.
    activityGroupLinks: seed(
      Schema.Struct({
        activityId: key(1)(Schema.String),
        groupId: key(2)(Schema.String),
      }),
    ),
  },
})

const migration0007 = migration0006.appendMigration({
  file: '0007',
  name: 'unique',
  entities: {
    // Tests a generated identity with a reusable unique value.
    aliases: seed(
      Schema.Struct({
        id: key(1)(Schema.String),
        name: unique(1)(Schema.String),
        color: Schema.NullOr(Schema.String),
        ...deletedAt,
        ...createdAt,
      }),
    ),
  },
})

export const FIXTURE_INDEX = migration0007

/** Resolves fixture slot addresses from table names, keys, and field names. */
export const { change, tableOf, fieldOf, entityIdFor, fieldIdFor, touchedTables } =
  replication.makeAddressing(FIXTURE_INDEX)

/** Whatever the fixture calls an account. Opaque to every query that takes one. */
export const TEST_ACCOUNT = 'account-1'

/**
 * Binds fixture operations to an index while accepting a connection per call. Production
 * uses `makePeerStore` to bind the connection and clock too.
 */
export const boundTo = (index: migration.SchemaIndex) => {
  const bound =
    <Args extends ReadonlyArray<unknown>, R>(
      f: (sql: SqlClient.SqlClient, index: migration.SchemaIndex, ...args: Args) => R,
    ) =>
    (sql: SqlClient.SqlClient, ...args: Args): R =>
      f(sql, index, ...args)

  return {
    drainOverflow: bound(migration.drainOverflow),
    applyChanges: bound(apply.applyChanges),
    changesSince: bound(changes.changesSince),
    purgeTombstoned: bound(purge.purgeTombstoned),
    registerPeer: bound(roster.registerPeer),
    observePeer: bound(roster.observePeer),
    listPeers: bound(roster.listPeers),
    evictPeer: bound(roster.evictPeer),
    everyPeerReached: bound(roster.everyPeerReached),
    getOrCreateCounterpartSyncCursors: bound(
      counterpartSyncState.getOrCreateCounterpartSyncCursors,
    ),
    setCounterpartSyncCursors: bound(counterpartSyncState.setCounterpartSyncCursors),
    getSelfSyncPosition: bound(peerSyncState.getSelfSyncPosition),
    getPeerSyncCursors: bound(peerSyncState.getPeerSyncCursors),
    setPeerSyncCursors: bound(peerSyncState.setPeerSyncCursors),
    getOrCreatePeerId: bound(peerSyncState.getOrCreatePeerId),
  }
}

/** Storage operations bound to the fixture index. */
export const {
  drainOverflow,
  applyChanges,
  changesSince,
  purgeTombstoned,
  registerPeer,
  observePeer,
  listPeers,
  evictPeer,
  everyPeerReached,
  getSelfSyncPosition,
  getPeerSyncCursors,
  setPeerSyncCursors,
  getOrCreatePeerId,
} = boundTo(FIXTURE_INDEX)

/** `stampChanges` bound to the fixture index, resolving the entity from a table name. */
export const stampChanges = (
  sql: SqlClient.SqlClient,
  hlc: Hlc,
  table: string,
  rowId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) => {
  const entity = FIXTURE_INDEX.entityForTable(table)
  return replication.stampChanges(sql, entity, hlc, rowId, before, after)
}

/** The key fields of a row, named the way a write states them. */
export const keyValues = (table: string, keys: ReadonlyArray<string>): Record<string, unknown> =>
  FIXTURE_INDEX.entityForTable(table).keyValues(keys)
