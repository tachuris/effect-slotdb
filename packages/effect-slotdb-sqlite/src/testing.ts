import * as Layer from 'effect/Layer'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { FIXTURE_INDEX } from '@tachuris/effect-slotdb/testing'
import { migrate } from './migrator.ts'

export * from '@tachuris/effect-slotdb/testing'

/** Creates a separate in memory store for each invocation. */
export const makeInMemorySqliteLayer = () => SqliteClient.layer({ filename: ':memory:' })

/** A store with the fixture chain applied, ready to read and write. */
export const FixtureLayer = Layer.effectDiscard(migrate(FIXTURE_INDEX)).pipe(
  Layer.provideMerge(makeInMemorySqliteLayer()),
)
