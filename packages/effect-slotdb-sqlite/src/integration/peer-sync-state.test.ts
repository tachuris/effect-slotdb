import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { SqlClient } from 'effect/sql'
import { FixtureLayer, getOrCreatePeerId } from '../testing.ts'

describe('getOrCreatePeerId', () => {
  it.effect('generates a stable peer id and returns the same one thereafter', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const first = yield* getOrCreatePeerId(sql)
      expect(first).toMatch(/^[0-9a-f]{32}$/)
      const second = yield* getOrCreatePeerId(sql)
      expect(second).toBe(first)
    }).pipe(Effect.provide(FixtureLayer)),
  )
})
