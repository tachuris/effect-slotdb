/**
 * The browser relay client using `fetch`. Keep request and response types consistent with
 * `examples/server/src/relay.ts`.
 */

import * as Effect from 'effect/Effect'
import { Schema } from 'effect'
import { ChangeBatch } from '@tachuris/effect-slotdb/changes'

/** Outgoing client changes with a pull cursor in the relay's sequence. */
export const SyncRequest = Schema.Struct({
  peerId: Schema.String,
  push: ChangeBatch,
  pullCursor: Schema.Number,
})

/** Changes after the pull cursor with the next relay sequence cursor. */
export const SyncResponse = Schema.Struct({ apply: ChangeBatch, serverSeq: Schema.Number })

/** Sends outgoing client changes and reads relay changes after the pull cursor. */
export const syncWith = (base: string, request: typeof SyncRequest.Type) =>
  Effect.tryPromise({
    try: async _signal => {
      const response = await fetch(`${base}/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!response.ok) throw new Error(`sync failed: HTTP ${response.status}`)
      return Schema.decodeUnknownSync(SyncResponse)(await response.json())
    },
    catch: error => new Error(`sync failed: ${String(error)}`),
  })
