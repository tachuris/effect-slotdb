import * as path from 'node:path'
import * as url from 'node:url'
import type { Migration } from '@tachuris/effect-slotdb/migration'
import { readDdl as readArtifact } from '@tachuris/effect-slotdb-sqlite/artifact'
import { EXAMPLE_SCHEMA_INDEX } from '../src/index'

// Keep filesystem paths outside src so browsers can import the chain.

const scriptsDir = path.dirname(url.fileURLToPath(import.meta.url))

/** One chain whose DDL the script writes. */
export interface DdlArtifact {
  readonly name: string
  readonly chain: readonly Migration[]
  readonly path: string
}

/**
 * Chains and paths for regenerating committed DDL. Add each chain here to include its
 * artifact in regeneration.
 */
export const DDL_ARTIFACTS: ReadonlyArray<DdlArtifact> = [
  {
    name: 'example',
    chain: EXAMPLE_SCHEMA_INDEX.chain,
    path: path.join(scriptsDir, '..', 'example.sql'),
  },
]

/** The DDL regeneration command included in stale artifact messages. */
export const REGENERATE_COMMAND = 'vp run schema:ddl'

/** Reads the DDL as committed, or returns `undefined` before one exists. */
export const readDdl = (ddlPath: string): string | undefined => readArtifact(ddlPath)
