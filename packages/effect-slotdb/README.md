# @tachuris/effect-slotdb

A replicated store whose field identities, storage codecs, and columns derive from a schema migration chain. The package supports application schemas independently of a SQL driver. The SQLite implementation is `@tachuris/effect-slotdb-sqlite`.

## `./migration`

Derives a schema index from a migration chain. Entity IDs depend on original entity names. Field IDs depend on original field names and the migration files that declare the fields. Renaming preserves IDs and stored columns, so peers can exchange field changes while using different application names.

The migration operations declare entities and fields, rename entities and fields, remove fields, change codecs or stored types, combine fields, and store derived fields. The index retains retired field IDs with their columns and codecs so peers can continue to relay older fields.

Entity entries resolve application names, columns, row IDs, and codecs for reads and writes. The `sql/` modules define replication metadata tables and drain overflow values into columns understood by the current build. The drain runs on startup, including after returning from an older build.

The identity lockfile records IDs, columns, and fingerprints for review. Validation detects changes that conflict with recorded field identities.

## `./replication`

Merges field changes, pages outgoing changes, purges deleted rows, and manages sync metadata and peer registrations through SQL.

`makePeerStore(sql, index, clock)` binds operations to one connection, schema index, and clock. The resulting operations require no additional services. `getOrCreatePeerId(sql, index)` reads or creates the stored peer ID. Use that ID as the `node` argument to `HybridLogicalClock.layer` before constructing the peer store. `Hlc.node` identifies the writer of a clock stamp.

`PeerSyncState` stores the local peer's identity and sync cursors under `peerSyncState`. `PeerRoster` records membership and progress under `peers`. To adopt these names in an applied chain, preserve the birth declarations and append `renameEntity` and `rename('deviceId', 'peerId')` operations. Renames retain stored IDs and columns. The example chain includes these operations.

Operations return typed results, including `RosterEntry` and `PurgeReport`. Consumers map `StorageError` to their application error types. Purging requires progress reports that confirm the registered peers have received a deleted row's final writes.

## `./records`

Provides typed row reads and writes through `Db`. Row types derive from the chain's declared field schemas. Writes stamp changed replicated fields and store local fields without stamps.

## `./changes`

Defines the hybrid logical clock and the field change format exchanged by peers. Changes identify slots by entity, row, and field IDs rather than application names.

## `./artifact`

Reads and regenerates identity lockfiles at caller supplied paths. Regeneration reports conflicts rather than overwriting incompatible recorded identities.

## `./testing`

Provides a fixture chain and operations bound to its schema index. SQL drivers can use the fixtures to test storage behavior.

## Layout

Modules that issue SQL are in `sql/` directories. Other modules derive schemas and types or implement merge logic without accessing storage. The root entry point exports `StorageError` and `UniqueViolation`.

## Schema annotations

Field annotation types extend the `Annotations` namespace in `effect/Schema` through module augmentation. The package's source exports and generated declaration files include the augmentation for consumers.
