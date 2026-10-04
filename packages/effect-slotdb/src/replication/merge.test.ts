import { describe, expect, it } from '@effect/vitest'
import type { MergePolicy } from '../migration/annotations.ts'
import { mergeSlot, type Slot } from './merge.ts'

/** An ordered stamp independent of clock behavior. */
const compare = (a: number, b: number) => a - b
const slot = <V>(value: V, stamp: number): Slot<V, number> => ({ value, stamp })

const merge = <V>(policy: MergePolicy, a: Slot<V, number>, b: Slot<V, number> | undefined) =>
  mergeSlot(policy, a, b, compare)

const POLICIES: ReadonlyArray<{
  readonly policy: MergePolicy
  readonly x: unknown
  readonly y: unknown
}> = [
  { policy: 'lww', x: 'first', y: 'second' },
  { policy: 'fww', x: 'first', y: 'second' },
  { policy: 'max', x: 10, y: 3 },
  { policy: 'min', x: 10, y: 3 },
  { policy: 'or', x: true, y: false },
  { policy: 'and', x: true, y: false },
  { policy: 'union', x: ['a', 'b'], y: ['b', 'c'] },
]

describe('every policy is a lattice join', () => {
  it('gives the same result whichever order the two arrive in', () => {
    // Commutative merges produce the same result regardless of delivery order.
    for (const { policy, x, y } of POLICIES) {
      const forward = merge(policy, slot(y, 2), slot(x, 1))
      const backward = merge(policy, slot(x, 1), slot(y, 2))
      expect(forward.value, policy).toEqual(backward.value)
      expect(forward.stamp, policy).toEqual(backward.stamp)
    }
  })

  it('is unchanged by seeing the same write twice', () => {
    // Duplicate delivery and replay leave the result unchanged.
    for (const { policy, x, y } of POLICIES) {
      const once = merge(policy, slot(y, 2), slot(x, 1))
      const twice = merge(policy, slot(y, 2), once)
      expect(twice.value, policy).toEqual(once.value)
    }
  })

  it('gives the same result however three writes are grouped', () => {
    // Associative, so a peer can merge a batch or merge one at a time.
    for (const { policy, x, y } of POLICIES) {
      const z = Array.isArray(y) ? ['d'] : y
      const leftFirst = merge(policy, slot(z, 3), merge(policy, slot(y, 2), slot(x, 1)))
      const rightFirst = merge(policy, merge(policy, slot(z, 3), slot(y, 2)), slot(x, 1))
      expect(leftFirst.value, policy).toEqual(rightFirst.value)
    }
  })

  it('takes the incoming write when there is nothing local', () => {
    for (const { policy, y } of POLICIES) {
      expect(merge(policy, slot(y, 1), undefined).value, policy).toEqual(y)
    }
  })
})

describe('last-write-wins and first-write-wins', () => {
  it('pick by stamp, in opposite directions', () => {
    expect(merge('lww', slot('new', 2), slot('old', 1)).value).toBe('new')
    expect(merge('fww', slot('new', 2), slot('old', 1)).value).toBe('old')
  })

  it('keep the local value when the stamps are concurrent', () => {
    // Equal stamps retain the local value. The clock comparison supplies a total order.
    expect(merge('lww', slot('incoming', 1), slot('local', 1)).value).toBe('local')
    expect(merge('fww', slot('incoming', 1), slot('local', 1)).value).toBe('local')
  })
})

describe('comparing values rather than stamps', () => {
  it('lets a present value beat an absent one, in either direction', () => {
    // Direct comparisons with null can retain an absent value.
    // Value policies must prefer a present value.
    expect(merge('max', slot('2024-01-01', 1), slot(null, 2)).value).toBe('2024-01-01')
    expect(merge('max', slot(null, 2), slot('2024-01-01', 1)).value).toBe('2024-01-01')
    expect(merge('min', slot('2024-01-01', 1), slot(null, 2)).value).toBe('2024-01-01')
    expect(merge('min', slot(null, 2), slot('2024-01-01', 1)).value).toBe('2024-01-01')
  })

  it('compares values independently of stamp order', () => {
    // The higher value wins despite its earlier stamp.
    expect(merge('max', slot(9, 1), slot(3, 2)).value).toBe(9)
    expect(merge('min', slot(9, 1), slot(3, 2)).value).toBe(3)
  })

  it('keeps the later stamp either way, so the result stays order-independent', () => {
    expect(merge('max', slot(9, 1), slot(3, 2)).stamp).toBe(2)
  })
})

describe('latches', () => {
  it('stay on once either side is on', () => {
    expect(merge('or', slot(false, 2), slot(true, 1)).value).toBe(true)
    expect(merge('or', slot(true, 1), slot(false, 2)).value).toBe(true)
  })

  it('stay off once either side is off, for the conjunction', () => {
    expect(merge('and', slot(true, 2), slot(false, 1)).value).toBe(false)
  })
})

describe('grow-only sets', () => {
  it('retain set entries from both peers', () => {
    // Independent flag updates must combine instead of overwriting each other.
    expect(merge('union', slot(['two'], 2), slot(['one'], 1)).value).toEqual(['one', 'two'])
  })

  it('sort, so two peers holding the same set serialize identically', () => {
    // Stable set order prevents the diff from restamping an unchanged set.
    expect(merge('union', slot(['b', 'a'], 2), slot(['c'], 1)).value).toEqual(['a', 'b', 'c'])
  })

  it('treat a non-list as empty rather than failing', () => {
    expect(merge('union', slot(['a'], 2), slot(null, 1)).value).toEqual(['a'])
  })
})
