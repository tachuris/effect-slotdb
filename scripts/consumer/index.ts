import type * as Schema from 'effect/Schema'
import * as SlotDb from '@tachuris/effect-slotdb'
import * as SlotDbArtifact from '@tachuris/effect-slotdb/artifact'
import * as Migration from '@tachuris/effect-slotdb/migration'
import * as Replication from '@tachuris/effect-slotdb/replication'
import * as Records from '@tachuris/effect-slotdb/records'
import * as Changes from '@tachuris/effect-slotdb/changes'
import * as SlotDbTesting from '@tachuris/effect-slotdb/testing'
import * as Sqlite from '@tachuris/effect-slotdb-sqlite'
import * as SqliteArtifact from '@tachuris/effect-slotdb-sqlite/artifact'
import type * as SqliteBun from '@tachuris/effect-slotdb-sqlite/bun'
import * as SqliteTesting from '@tachuris/effect-slotdb-sqlite/testing'
import * as SqliteWasm from '@tachuris/effect-slotdb-sqlite/wasm'

// `merge` has type `unknown` unless the d.ts keeps the `Annotations` augmentation.
const annotations: Schema.Annotations.Annotations = {}
export const merge: Migration.MergePolicy | undefined = annotations.merge

export type BunEntry = typeof SqliteBun

// Node cannot load the Bun entry at runtime, so the type import above covers it.
const entries = {
  SlotDb,
  SlotDbArtifact,
  Migration,
  Replication,
  Records,
  Changes,
  SlotDbTesting,
  Sqlite,
  SqliteArtifact,
  SqliteTesting,
  SqliteWasm,
}

for (const [name, entry] of Object.entries(entries)) {
  if (Object.keys(entry).length === 0) throw new Error(`${name} has no exports`)
}
console.log(`Loaded ${Object.keys(entries).length} entry points.`)
