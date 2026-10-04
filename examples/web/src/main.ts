#!/usr/bin/env bun
/**
 * Creates an in memory SQLite store, writes a task, and exchanges changes every two
 * seconds. Start the relay with `vp run example:server` and this app with `vp run
 * example:web`.
 */

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { SqlClient } from 'effect/sql'
import { EXAMPLE_SCHEMA_INDEX } from 'example-chain'
import { Db } from '@tachuris/effect-slotdb/records'
import { makePeerStore, getOrCreatePeerId } from '@tachuris/effect-slotdb/replication'
import { HybridLogicalClock } from '@tachuris/effect-slotdb/changes'
import { migrate } from '@tachuris/effect-slotdb-sqlite'
import { SqliteClientWasmMemory } from '@tachuris/effect-slotdb-sqlite/wasm'
import { syncWith } from './relay'

const tasks = EXAMPLE_SCHEMA_INDEX.typed.tasks

/** The relay's address. Match the `bun src/server.ts` default port. */
const RELAY_BASE = 'http://localhost:3030'

/** The interval between relay exchanges. */
const POLL_INTERVAL = '2 seconds'

const out = document.querySelector<HTMLPreElement>('#out')!
const taskList = document.querySelector<HTMLPreElement>('#tasks')!

const append = (line: string): void => {
  out.textContent = `${out.textContent}\n${line}`
  console.log(line)
}

/**
 * Replaces the rendered list. A repeating exchange re-renders instead of growing the page.
 */
const renderTasks = (lines: ReadonlyArray<string>): void => {
  taskList.textContent = lines.join('\n')
}

/**
 * Initializes the clock with the stored peer ID.
 * Migrates before reading the ID because the metadata table must exist.
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
    append('initializing wasm sqlite...')

    const sql = yield* SqlClient.SqlClient
    const db = new Db(sql)
    const store = makePeerStore(sql, EXAMPLE_SCHEMA_INDEX, yield* HybridLogicalClock)
    const peerId = yield* store.getOrCreatePeerId

    // Create one task per page load and repeat only the exchange.
    const id = `web-${Math.random().toString(36).slice(2, 8)}`
    yield* db.insert(tasks, {
      id,
      slug: `task-${id}`,
      title: `Hello from a browser at ${new Date().toLocaleTimeString()}`,
    })

    // Send unpushed changes and read changes after the stored relay cursor.
    const exchange = Effect.gen(function* () {
      const { pushCursor, pullCursor } = yield* store.getPeerSyncCursors
      const outbound = yield* store.changesSince({ cursor: pushCursor })
      const response = yield* syncWith(RELAY_BASE, {
        peerId,
        push: outbound.changes,
        pullCursor,
      })
      yield* store.applyChanges(response.apply)
      yield* store.setPeerSyncCursors(outbound.cursor, response.serverSeq)

      const rows = yield* db.all(tasks)
      renderTasks(rows.map(row => ` - ${row.slug} :: ${row.title}`))
      // Log exchanges only when changes were sent or received.
      if (outbound.changes.length > 0 || response.apply.length > 0) {
        append(
          `pushed ${outbound.changes.length}, pulled ${response.apply.length}, now ${rows.length} tasks`,
        )
      }
    })

    // Keep polling after failures because the relay may restart while the page is open.
    yield* Effect.forever(
      exchange.pipe(
        Effect.catchCause(cause =>
          Effect.sync(() => append(`exchange failed, retrying: ${String(cause)}`)),
        ),
        Effect.andThen(Effect.sleep(POLL_INTERVAL)),
      ),
    )
  }).pipe(
    Effect.tapError(error => Effect.sync(() => append(`error: ${String(error)}`))),
    Effect.provide(HclLayer),
    Effect.provide(SqliteClientWasmMemory('example-web')),
  ),
)
