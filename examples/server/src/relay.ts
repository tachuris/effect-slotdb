/**
 * Relays field changes between clients through one store. Each exchange merges incoming
 * changes and returns changes after a relay sequence cursor, excluding the sender's
 * writes.
 */

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import * as HttpBody from 'effect/http/HttpBody'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer'
import { EXAMPLE_SCHEMA_INDEX } from 'example-chain'
import { makePeerStore } from '@tachuris/effect-slotdb/replication'
import type { PeerStore } from '@tachuris/effect-slotdb/replication'
import { ChangeBatch, HybridLogicalClock } from '@tachuris/effect-slotdb/changes'
import { migrate } from '@tachuris/effect-slotdb-sqlite'
import { SqliteClientBun } from '@tachuris/effect-slotdb-sqlite/bun'

/** Outgoing client changes with a pull cursor in the relay's sequence. */
export const SyncRequest = Schema.Struct({
  peerId: Schema.String,
  push: ChangeBatch,
  pullCursor: Schema.Number,
})

/** Changes after the pull cursor with the next relay sequence cursor. */
export const SyncResponse = Schema.Struct({ apply: ChangeBatch, serverSeq: Schema.Number })

/** The relay's own store, so a route names the service instead of rebuilding it. */
export const RelayStore = Context.Service<PeerStore>('example-relay-store')

/** Constructs the relay store over the given sqlite connection, migrating it first. */
export const RelayStoreLive = Layer.effect(
  RelayStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* migrate(EXAMPLE_SCHEMA_INDEX)
    return makePeerStore(sql, EXAMPLE_SCHEMA_INDEX, yield* HybridLogicalClock)
  }),
)

/** Serves the relay over the platform's HTTP server. */
export const RelayRoutes = HttpRouter.addAll([
  HttpRouter.route(
    'POST',
    '/sync',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.schemaBodyJson(SyncRequest)
      const store = yield* RelayStore
      yield* store.applyChanges(request.push)
      const page = yield* store.changesSince({
        cursor: request.pullCursor,
        excludeNode: request.peerId,
      })
      return yield* HttpServerResponse.schemaJson(SyncResponse)({
        apply: page.changes,
        serverSeq: page.cursor,
      })
    }),
  ),
])

/** The relay's HTTP server, with routes, CORS, and the router layer wired in. */
export const RelayServer = HttpRouter.serve(
  RelayRoutes.pipe(Layer.provide(HttpRouter.layer), Layer.provide(HttpRouter.cors())),
  { disableListenLog: true },
)

/** The default relay address and its store file. A client overrides them with flags. */
export const PORT = Number(process.env.PORT ?? 3030)
export const RELAY_DB_PATH = process.env.RELAY_DB ?? './relay.db'

/** Runs the relay until the process ends. */
export const runRelay = (port: number, dbPath: string) =>
  Layer.launch(
    RelayServer.pipe(
      Layer.provide(RelayStoreLive),
      Layer.provide(BunHttpServer.layer({ port })),
      Layer.provide(SqliteClientBun(dbPath)),
      Layer.provide(HybridLogicalClock.layer('relay-server')),
    ),
  )

/** Sends outgoing client changes and reads relay changes after the pull cursor. */
export const syncWith = (base: string, request: typeof SyncRequest.Type) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.post(`${base}/sync`, {
      body: HttpBody.jsonUnsafe(request),
    })
    return yield* HttpIncomingMessage.schemaBodyJson(SyncResponse)(response)
  })

/** Provides the HTTP client for the relay exchange. */
export const HttpClientLive = FetchHttpClient.layer
