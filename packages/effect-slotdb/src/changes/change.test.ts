import { describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import { Hlc } from './hlc'
import { Change, touchedEntities } from './change'
import { EntityId, FieldId } from '../migration'

const decode = Schema.decodeUnknownSync(Change)

const wire = (overrides: Record<string, unknown> = {}) => ({
  entityId: '0123456789abcdef',
  rowId: 'r1',
  fieldId: 'fedcba9876543210',
  value: 'Reading',
  hlc: { millis: 10, counter: 0, node: 'dev' },
  ...overrides,
})

describe('the change wire contract', () => {
  it('includes IDs without application field or table names', () => {
    expect(Object.keys(Change.fields).sort()).toEqual([
      'entityId',
      'fieldId',
      'hlc',
      'rowId',
      'value',
    ])
  })

  it('accepts a well-formed pair of ids', () => {
    const change = decode(wire())
    expect(change.entityId).toBe('0123456789abcdef')
    expect(change.fieldId).toBe('fedcba9876543210')
  })

  it('refuses a malformed id before it can reach storage', () => {
    // Reject IDs that are not 16 hexadecimal digits.
    for (const bad of ['', 'notanid', '0123456789ABCDEF', '0123456789abcde', 'x123456789abcdef']) {
      expect(() => decode(wire({ fieldId: bad })), bad).toThrow(/well-formed id/)
      expect(() => decode(wire({ entityId: bad })), bad).toThrow(/well-formed id/)
    }
  })

  it('accepts an unknown ID', () => {
    // Unknown field IDs must decode so older peers can preserve newer fields.
    expect(decode(wire({ fieldId: 'aaaaaaaaaaaaaaaa' })).fieldId).toBe('aaaaaaaaaaaaaaaa')
  })

  it('reports distinct entity IDs affected by a batch', () => {
    const a = Change.new(
      EntityId.make('0123456789abcdef'),
      'r1',
      FieldId.make('fedcba9876543210'),
      1,
      Hlc.new(10),
    )
    const b = Change.new(
      EntityId.make('0123456789abcdef'),
      'r2',
      FieldId.make('fedcba9876543210'),
      2,
      Hlc.new(11),
    )
    const c = Change.new(
      EntityId.make('1111111111111111'),
      'r1',
      FieldId.make('fedcba9876543210'),
      3,
      Hlc.new(12),
    )
    expect(touchedEntities([a, b, c])).toEqual(['0123456789abcdef', '1111111111111111'])
  })
})
