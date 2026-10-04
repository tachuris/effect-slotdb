import * as path from 'node:path'
import * as url from 'node:url'
import type { LockedChain } from '@tachuris/effect-slotdb/artifact'
import { EXAMPLE_SCHEMA_INDEX } from '../src/index'

// Keep filesystem reads outside src so browsers can import the chain.

const scriptsDir = path.dirname(url.fileURLToPath(import.meta.url))

/**
 * Chains and paths for regenerating committed lockfiles. Add each chain here to include
 * its artifact in regeneration.
 */
export const LOCKED_CHAINS: ReadonlyArray<LockedChain> = [
  {
    name: 'example',
    index: EXAMPLE_SCHEMA_INDEX,
    path: path.join(scriptsDir, '..', 'example.lock'),
  },
]

/** The lockfile regeneration command included in stale artifact messages. */
export const REGENERATE_COMMAND = 'vp run schema:lock'
