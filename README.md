# effect-slotdb

> THIS PACKAGE IS EXPERIMENTAL. DO NOT USE IN PRODUCTION.

A replicated store for [Effect](https://effect.website) with a SQLite implementation. A schema migration chain defines field IDs, columns, and merge policies. Renaming preserves field IDs and stored columns. Peers preserve unknown fields so older builds can relay data from newer builds.

## Packages

`@tachuris/effect-slotdb` provides these entry points:

- `./migration`: derives field identities, storage codecs, and columns from a migration chain.
- `./replication`: merges field changes, pages outgoing changes, purges deleted rows, and manages sync metadata and peer registrations through SQL.
- `./records`: provides typed row operations through `Db`, including `insert`, `put`, `update`, `remove`, and `find`.
- `./changes`: defines the hybrid logical clock and the change format exchanged by peers.
- `./artifact`: reads and regenerates committed identity lockfiles.
- `./testing`: provides a fixture chain and operations bound to its schema index.

`@tachuris/effect-slotdb-sqlite` provides these entry points:

- `.`: derives SQLite DDL, checks the stored schema, and applies migrations with `migrate`.
- `./bun`: provides a Bun `SqlClient` layer.
- `./wasm`: provides a browser `SqlClient` layer using wa-sqlite with OPFS or memory storage.
- `./artifact`: renders committed migration SQL.
- `./testing`: provides an in memory SQLite store with the fixture chain applied.

## Example apps

The `examples/` directory demonstrates migration, row operations, and replication:

- `examples/chain`: defines a migration chain, its committed identity lockfile and DDL, and tests that compare the artifacts with the chain.
- `examples/bun`: migrates two stores, writes rows through `Db`, and replicates changes between peers in one process.
- `examples/server`: runs an HTTP relay. Clients send outgoing changes and receive changes after their stored cursor in the relay's sequence.
- `examples/web`: runs a browser app with the WebAssembly driver. Each tab writes one task and exchanges changes with the relay every two seconds.

```bash
vp run example:cli     # Run the Bun example.
vp run example:server  # Run the relay on port 3030.
vp run example:web     # Run the browser app.
```

## Development

```bash
vp install     # Install workspace dependencies.
vp check --fix # Format, lint, and check types.
vp test        # Run the test suite.
vp run arch    # Check dependency rules in .dependency-cruiser.mjs.
vp run build   # Build both packages into their dist directories.
```

After changing the migration chain in `examples/chain`, regenerate the artifacts and review the diff:

```bash
vp run schema:lock
vp run schema:ddl
```

`vp test` fails when a committed artifact differs from the chain. `schema:lock` refuses to overwrite a lockfile when the chain contradicts recorded field identities or merge policies.

## Releasing

See [RELEASING.md](RELEASING.md).

## License

MIT
