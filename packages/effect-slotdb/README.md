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

`PeerSyncState` stores local peer identity and compatibility cursors under `peerSyncState`. `CounterpartSyncState` stores separate cursors for each remote dataset under `counterpartSyncState`. Both entities contain only local fields. `PeerRoster` stores replicated membership and local progress observations under `peers`. For an applied chain with different entity or field names, preserve the birth declarations and append the required `renameEntity` or `rename` operations. Renames retain stored IDs and columns.

Operations return typed results, including `RosterEntry` and `PurgeReport`. Consumers map `StorageError` to their application error types. Purging requires progress reports that confirm the registered peers have received a deleted row's final writes.

### Local identity and cursor ownership

`PeerSyncState` has one row addressed by `id = 0`. The row stores the local `peerId`, which `getOrCreatePeerId` creates independently of any counterpart. Declare `PeerSyncState` even when using counterpart cursors. Local peer identity remains the same when the consumer selects a different counterpart.

The singleton `pushCursor` and `pullCursor` fields support consumers of `getPeerSyncCursors` and `setPeerSyncCursors`. These compatibility methods record progress without a counterpart identity. Singleton cursors cannot distinguish different remote datasets. Call `getOrCreatePeerId` before recording singleton progress because the setter updates the existing identity row.

`CounterpartSyncState` has one row per `counterpartId` and contains no local peer identity. New integrations use `getOrCreateCounterpartSyncCursors` and `setCounterpartSyncCursors` for exchange progress, including when they currently connect to one counterpart. A stable identity distinguishes a replacement dataset at the same URL and identifies the same dataset at a different URL.

The two entities have separate records because one local peer can exchange with several counterparts. `PeerStore` provides the identity and cursor operations together. In either cursor API, `pushCursor` refers to the local change sequence and `pullCursor` refers to the remote change sequence. Pull cursors from different counterparts cannot share progress.

### Counterpart cursors

Append `counterpartSyncState: seed(CounterpartSyncState)` to the consuming migration chain to track separate push and pull cursors for each counterpart. Import `CounterpartSyncState` from `./replication` and `seed` from `./migration`. Supply a stable identity for the counterpart's dataset. URLs, certificate lookup, and pairing belong to the consumer.

`store.getOrCreateCounterpartSyncCursors(counterpartId)` creates zero progress on first contact and reads the stored progress afterward. `store.setCounterpartSyncCursors(counterpartId, push, pull)` records a completed exchange, including when the counterpart has no cursor row yet. These methods leave peer identity and singleton cursors unchanged. Existing singleton progress has no counterpart identity, so the keyed methods do not adopt singleton progress. Replay uses `changesSince` with the stored HLCs.

With the counterpart entity in the chain, purge requires every tracked counterpart's push cursor to cover the deleted row's final local sequence. Purge also requires the existing roster observations. No counterpart records means no acknowledged push progress. `PurgeReport.blockedCounterparts` lists counterparts that prevent removal, and `selfBehind` includes missing counterpart acknowledgements. An abandoned counterpart can block purge because the library does not expire or remove cursor records. Chains without the counterpart entity keep the singleton purge rules and omit `blockedCounterparts`.

Use `boundTo(index)` from `./testing` to obtain counterpart cursor helpers for a chain that includes the entity. The default fixture chain omits counterpart state and exercises singleton compatibility.

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
