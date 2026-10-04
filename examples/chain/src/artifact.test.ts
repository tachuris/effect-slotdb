import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { readLockfile } from '@tachuris/effect-slotdb/artifact'
import { checkLockfile } from '@tachuris/effect-slotdb/migration'
import { checkDatabase, deriveMigrations, migrate } from '@tachuris/effect-slotdb-sqlite'
import { renderDdl } from '@tachuris/effect-slotdb-sqlite/artifact'
import { makeInMemorySqliteLayer } from '@tachuris/effect-slotdb-sqlite/testing'
import { EXAMPLE_SCHEMA_INDEX } from './index'
import { DDL_ARTIFACTS, readDdl, REGENERATE_COMMAND as DDL_COMMAND } from '../scripts/ddl-path'
import { LOCKED_CHAINS, REGENERATE_COMMAND as LOCK_COMMAND } from '../scripts/lockfile-path'

/**
 * Checks committed identity and DDL artifacts against the chain. Uses the same validation
 * rules as artifact regeneration.
 */

describe.each(LOCKED_CHAINS)('the $name lockfile', ({ index, path }) => {
  it('agrees with the chain', () => {
    const problems = checkLockfile(index, readLockfile(path))
    expect(
      problems.map(problem => `[${problem.code}] ${problem.message}`),
      `Run \`${LOCK_COMMAND}\` and review the diff`,
    ).toEqual([])
  })
})

describe.each(DDL_ARTIFACTS)('the committed $name DDL', ({ chain, path }) => {
  it('matches the SQL derived from the chain', () => {
    expect(
      readDdl(path),
      `The committed DDL is stale. Run \`${DDL_COMMAND}\` and review the diff`,
    ).toBe(renderDdl(deriveMigrations(chain)))
  })
})

describe('the example schema against the chain', () => {
  it('matches, in both directions', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* migrate(EXAMPLE_SCHEMA_INDEX)
        expect(yield* checkDatabase(EXAMPLE_SCHEMA_INDEX)).toEqual([])
      }).pipe(Effect.provide(makeInMemorySqliteLayer())),
    ))
})
