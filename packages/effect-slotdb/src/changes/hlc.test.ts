import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { decodeHlcColumn, encodeHlcColumn, Hlc, HybridLogicalClock } from './hlc'

describe('hlc', () => {
  it('sendEvent increments the counter within a millisecond and resets it when time advances', () => {
    expect(Hlc.new(10, 0).sendEvent(10)).toEqual(Hlc.new(10, 1))
    expect(Hlc.new(10, 3).sendEvent(5)).toEqual(Hlc.new(10, 4)) // physical regressed: hold millis, bump
    expect(Hlc.new(10, 3).sendEvent(20)).toEqual(Hlc.new(20, 0)) // physical advanced: reset counter
  })

  it('receiveEvent advances the local clock past the remote stamp', () => {
    expect(Hlc.new(10, 5).receiveEvent(12, Hlc.new(20, 2))).toEqual(Hlc.new(20, 3)) // remote ahead
    expect(Hlc.new(20, 5).receiveEvent(15, Hlc.new(20, 2))).toEqual(Hlc.new(20, 6)) // same millis, max+1
    expect(Hlc.new(10, 5).receiveEvent(30, Hlc.new(12, 2))).toEqual(Hlc.new(30, 0)) // local physical leads
  })

  it('compare orders by millis, then counter, then node', () => {
    expect(Hlc.compare(Hlc.new(1, 0), Hlc.new(2, 0))).toBe(-1)
    expect(Hlc.compare(Hlc.new(2, 1), Hlc.new(2, 0))).toBe(1)
    expect(Hlc.compare(Hlc.new(2, 0, 'a'), Hlc.new(2, 0, 'b'))).toBe(-1)
    expect(Hlc.compare(Hlc.new(2, 0, 'a'), Hlc.new(2, 0, 'a'))).toBe(0)
  })

  it('beating returns a greater stamp regardless of node names', () => {
    // The node is compared last, so a correction wins even under a node that sorts lower.
    const prior = Hlc.new(10, 4, 'zzz')
    expect(Hlc.compare(Hlc.beating('aaa', prior), prior)).toBe(1)
    expect(Hlc.beating('aaa', prior)).toEqual(Hlc.new(10, 5, 'aaa'))
  })

  it('beating without a prior returns time zero and counter one', () => {
    const first = Hlc.beating('server')
    expect(first).toEqual(Hlc.new(0, 1, 'server'))
    expect(Hlc.compare(first, Hlc.zero('server'))).toBe(1)
  })

  it('beating returns the same stamp for the same inputs', () => {
    // Deriving a correction from the same stamp produces the same result on retry.
    const prior = Hlc.new(7, 0, 'peer-1')
    expect(Hlc.beating('server', prior)).toEqual(Hlc.beating('server', prior))
  })

  it('encode round-trips and sorts lexicographically in HLC order', () => {
    const a = Hlc.new(10, 2, 'node-1')
    expect(decodeHlcColumn(encodeHlcColumn(a))).toEqual(a)
    expect(encodeHlcColumn(Hlc.new(9, 999, 'z')) < encodeHlcColumn(Hlc.new(10, 0, 'a'))).toBe(true)
    expect(encodeHlcColumn(Hlc.new(10, 2, 'a')) < encodeHlcColumn(Hlc.new(10, 3, 'a'))).toBe(true)
  })

  it.effect('now increments the counter at a fixed physical time', () =>
    Effect.gen(function* () {
      const clock = yield* HybridLogicalClock
      const first = yield* clock.now
      const second = yield* clock.now
      expect(second.millis).toBe(first.millis)
      expect(second.counter).toBe(first.counter + 1)
    }).pipe(Effect.provide(HybridLogicalClock.layer('node-a', () => 1000))),
  )

  it.effect('receive advances past a remote stamp and subsequent now remains later', () =>
    Effect.gen(function* () {
      const clock = yield* HybridLogicalClock
      const merged = yield* clock.receive(Hlc.new(2_000_000_000_000, 7, 'peer'))
      expect(merged.millis).toBe(2_000_000_000_000)
      expect(merged.counter).toBe(8)
      const next = yield* clock.now
      expect(next.millis).toBe(2_000_000_000_000)
      expect(next.counter).toBe(9)
    }).pipe(Effect.provide(HybridLogicalClock.layer('node-a', () => 1000))),
  )
})
