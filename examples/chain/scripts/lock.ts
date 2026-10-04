#!/usr/bin/env bun
/**
 * Regenerates identity lockfiles with `vp run schema:lock`. Reports and skips chains that
 * conflict with their committed lockfiles.
 */

import { writeLockfiles } from '@tachuris/effect-slotdb/artifact'
import { LOCKED_CHAINS } from './lockfile-path'

const { written, refused } = writeLockfiles(LOCKED_CHAINS)

for (const chain of written) {
  console.log(`Wrote ${chain.path} (${chain.name})`)
}

for (const { chain, problems } of refused) {
  console.error(`\nRefusing to write ${chain.path}.\n`)
  for (const problem of problems) console.error(`  [${problem.code}] ${problem.message}\n`)
  console.error('Resolve the reported conflicts before regenerating the lockfile.\n')
}

if (refused.length > 0) {
  process.exit(1)
}
