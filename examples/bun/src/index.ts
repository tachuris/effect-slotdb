/**
 * Migrates, writes, reads, and replicates two stores. Run `bun src/index.ts [dbPath]`.
 * Without a path, creates a temporary database.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import { SqlClient } from 'effect/sql'
import { EXAMPLE_SCHEMA_INDEX } from 'example-chain'
import { Db } from '@tachuris/effect-slotdb/records'
import { makePeerStore } from '@tachuris/effect-slotdb/replication'
import { HybridLogicalClock } from '@tachuris/effect-slotdb/changes'
import type { ChangeBatch } from '@tachuris/effect-slotdb/changes'
import { migrate } from '@tachuris/effect-slotdb-sqlite'
import { SqliteClientBun } from '@tachuris/effect-slotdb-sqlite/bun'

const tasks = EXAMPLE_SCHEMA_INDEX.typed.tasks

const dbPath = process.argv[2] ?? join(tmpdir(), `effect-slotdb-example-${process.pid}.db`)
console.log({ dbPath })

const createTask = Effect.gen(function* () {
  const db = new Db(yield* SqlClient.SqlClient)
  yield* db.insert(tasks, { id: 't1', slug: 'buy-milk', title: 'Buy milk' })
  yield* db.update(tasks, { id: 't1' }, { tags: ['errands'] })
  yield* db.update(tasks, { id: 't1' }, { completed: true })

  const row = yield* db.find(tasks, { id: 't1' })
  if (row === undefined) throw new Error('The inserted task was not found')
  // An absent optional dueAt field decodes from SQL NULL to undefined.
  if (row.dueAt !== undefined) throw new Error('An absent optional field must decode as undefined')

  console.log('peer A created and read back:', row)
})

const listTasks = Effect.gen(function* () {
  const db = new Db(yield* SqlClient.SqlClient)
  const rows = yield* db.all(tasks)
  console.log('peer A sees', rows.length, 'tasks')
})

const sync = Effect.gen(function* () {
  const store = makePeerStore(
    yield* SqlClient.SqlClient,
    EXAMPLE_SCHEMA_INDEX,
    yield* HybridLogicalClock,
  )
  const outbound = yield* store.changesSince()
  console.log('peer A has', outbound.changes.length, 'outgoing changes')
  return outbound.changes
})

/** The second store: a fresh in-memory peer that applies peer A's outbound changes. */
const peerB = (changes: ChangeBatch) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* migrate(EXAMPLE_SCHEMA_INDEX)
    const store = makePeerStore(sql, EXAMPLE_SCHEMA_INDEX, yield* HybridLogicalClock)
    yield* store.applyChanges(changes)

    const row = yield* new Db(sql).find(tasks, { id: 't1' })
    if (row?.title !== 'Buy milk') throw new Error('Peer B read an unexpected task title')
    console.log('peer B applied', changes.length, 'changes and converged on:', row)
  })

void Effect.runPromise(
  Effect.gen(function* () {
    console.log('db file:', dbPath)
    yield* migrate(EXAMPLE_SCHEMA_INDEX)
    yield* createTask
    yield* listTasks
    yield* Effect.flatMap(sync, peerB)
  }).pipe(
    Effect.provide(SqliteClientBun(dbPath)),
    Effect.provide(HybridLogicalClock.layer('example-peer-a')),
  ),
).then(() => console.log('done'))
