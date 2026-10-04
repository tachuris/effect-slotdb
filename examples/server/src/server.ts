#!/usr/bin/env bun
/**
 * Runs the relay with `bun src/server.ts`. Defaults to port 3030 and `relay.db` in the
 * working directory. Override with `PORT` and `RELAY_DB`.
 */

import * as Effect from 'effect/Effect'
import { runRelay, PORT, RELAY_DB_PATH } from './relay'

console.log(`relay on http://localhost:${PORT}, store at ${RELAY_DB_PATH}`)
void Effect.runPromise(runRelay(PORT, RELAY_DB_PATH))
