import type { MergePolicy } from '../migration'

/**
 * Merge policies for concurrent slot writes. Policies are commutative, associative, and
 * idempotent. Callers supply stamp ordering independently of the clock implementation.
 */

/**
 * One slot: a value and the stamp it was written under.
 * @internal
 */
export interface Slot<V, S> {
  readonly value: V
  readonly stamp: S
}

/**
 * Negative for an earlier first stamp, positive for a later stamp, and zero for equal
 * stamps.
 */
type CompareStamps<S> = (a: S, b: S) => number

/**
 * Whether a value is absent. Value comparisons prefer present values to null or
 * undefined.
 */
const isAbsent = (value: unknown): boolean => value === null || value === undefined

const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

/**
 * @internal
 */
export const mergeSlot = <V, S>(
  policy: MergePolicy,
  incoming: Slot<V, S>,
  local: Slot<V, S> | undefined,
  compare: CompareStamps<S>,
): Slot<V, S> => {
  if (local === undefined) return incoming

  // Retain the later stamp for value comparisons so arrival order does not affect the
  // result.
  const later = compare(incoming.stamp, local.stamp) >= 0 ? incoming.stamp : local.stamp

  switch (policy) {
    case 'lww':
      return compare(incoming.stamp, local.stamp) > 0 ? incoming : local

    case 'fww':
      return compare(incoming.stamp, local.stamp) < 0 ? incoming : local

    case 'max':
    case 'min': {
      if (isAbsent(incoming.value)) return { value: local.value, stamp: later }
      if (isAbsent(local.value)) return { value: incoming.value, stamp: later }

      const takeIncoming =
        policy === 'max'
          ? (incoming.value as any) > (local.value as any)
          : (incoming.value as any) < (local.value as any)
      return { value: takeIncoming ? incoming.value : local.value, stamp: later }
    }

    case 'or':
      return {
        value: (Boolean(incoming.value) || Boolean(local.value)) as V,
        stamp: later,
      }

    case 'and':
      return {
        value: (Boolean(incoming.value) && Boolean(local.value)) as V,
        stamp: later,
      }

    case 'union': {
      // Sort with an explicit element comparison so peers serialize equal sets
      // identically.
      // Stable serialization prevents unchanged sets from being restamped.
      const merged = [...new Set([...asArray(local.value), ...asArray(incoming.value)])].sort(
        (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0),
      )
      return { value: merged as V, stamp: later }
    }
  }
}
