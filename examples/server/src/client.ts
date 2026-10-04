#!/usr/bin/env bun
/**
 * Writes a task and exchanges changes with the relay. Run `bun src/client.ts [baseUrl]
 * [dbPath]`. Defaults to localhost port 3030 and a temporary database.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { SqlClient } from 'effect/sql'
import { EXAMPLE_SCHEMA_INDEX } from 'example-chain'
import { Db } from '@tachuris/effect-slotdb/records'
import { makePeerStore, getOrCreatePeerId } from '@tachuris/effect-slotdb/replication'
import { HybridLogicalClock } from '@tachuris/effect-slotdb/changes'
import { migrate } from '@tachuris/effect-slotdb-sqlite'
import { SqliteClientBun } from '@tachuris/effect-slotdb-sqlite/bun'
import { HttpClientLive, syncWith } from './relay'

const tasks = EXAMPLE_SCHEMA_INDEX.typed.tasks

const base = process.argv[2] ?? 'http://localhost:3030'
const dbPath = process.argv[3] ?? join(tmpdir(), `effect-slotdb-client-${process.pid}.db`)

/**
 * Initializes the clock with the stored peer ID. Migrates before reading the ID because
 * the metadata table must exist.
 */
const HclLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* migrate(EXAMPLE_SCHEMA_INDEX)
    const peerId = yield* getOrCreatePeerId(sql, EXAMPLE_SCHEMA_INDEX)
    return HybridLogicalClock.layer(peerId)
  }),
)

void Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const db = new Db(sql)
    const store = makePeerStore(sql, EXAMPLE_SCHEMA_INDEX, yield* HybridLogicalClock)
    const peerId = yield* store.getOrCreatePeerId
    console.log('peer', peerId, 'at', dbPath, 'syncing with', base)

    // Create a task for this run before exchanging changes.
    yield* db.insert(tasks, {
      id: `c-${process.pid}`,
      slug: `task-${process.pid}`,
      title: 'Hello from a peer',
    })

    // Send unpushed changes and read changes after the stored relay cursor.
    const { pushCursor, pullCursor } = yield* store.getPeerSyncCursors
    const outbound = yield* store.changesSince({ cursor: pushCursor })
    const response = yield* syncWith(base, {
      peerId,
      push: outbound.changes,
      pullCursor,
    })
    yield* store.applyChanges(response.apply)
    yield* store.setPeerSyncCursors(outbound.cursor, response.serverSeq)
    console.log('pushed', outbound.changes.length, ', pulled', response.apply.length)

    const rows = yield* db.all(tasks)
    console.log('converged task list:')
    for (const row of rows)
      console.log(' -', row.slug, '::', row.title, row.completed ? '(done)' : '')
  }).pipe(
    Effect.provide(HttpClientLive),
    Effect.provide(HclLayer),
    Effect.provide(SqliteClientBun(dbPath)),
  ),
).then(() => process.exit(0))
