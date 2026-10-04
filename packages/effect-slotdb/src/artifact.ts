import * as fs from 'node:fs'
import type { Diagnostic } from './migration'
import { blocksRegeneration, checkLockfile } from './migration'
import type { SchemaIndex } from './migration'

/** Reads and writes identity lockfiles at caller supplied paths. */

/** One chain and the lockfile that records it. */
export interface LockedChain {
  readonly name: string
  readonly index: SchemaIndex
  readonly path: string
}

/** A chain skipped during regeneration, with the reported problems. */
export interface RefusedChain {
  readonly chain: LockedChain
  readonly problems: ReadonlyArray<Diagnostic>
}

/** The chains written and skipped during regeneration. Each chain appears in one list. */
export interface LockfileWriteResult {
  readonly written: ReadonlyArray<LockedChain>
  readonly refused: ReadonlyArray<RefusedChain>
}

/** The committed lockfile, or `undefined` before one exists. */
export const readLockfile = (path: string): string | undefined =>
  fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : undefined

/**
 * Rewrites lockfiles unless the chain contradicts recorded field identities. Reports
 * every skipped chain. Callers must report conflicts rather than overwrite the lockfile.
 */
export const writeLockfiles = (chains: ReadonlyArray<LockedChain>): LockfileWriteResult => {
  const written: LockedChain[] = []
  const refused: RefusedChain[] = []

  for (const chain of chains) {
    const problems = checkLockfile(chain.index, readLockfile(chain.path)).filter(blocksRegeneration)
    if (problems.length > 0) {
      refused.push({ chain, problems })
      continue
    }
    fs.writeFileSync(chain.path, `${chain.index.lockfile()}\n`)
    written.push(chain)
  }

  return { written, refused }
}
