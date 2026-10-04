#!/usr/bin/env bun
/**
 * Regenerates committed migration SQL with `vp run schema:ddl`. Review changes to
 * sections for applied migrations before publishing.
 */

import { writeFile } from 'node:fs/promises'
import { deriveMigrations } from '@tachuris/effect-slotdb-sqlite'
import { renderDdl } from '@tachuris/effect-slotdb-sqlite/artifact'
import { DDL_ARTIFACTS } from './ddl-path.ts'

for (const { name, chain, path } of DDL_ARTIFACTS) {
  await writeFile(path, renderDdl(deriveMigrations(chain)))
  console.log(`Wrote ${path} (${name})`)
}
