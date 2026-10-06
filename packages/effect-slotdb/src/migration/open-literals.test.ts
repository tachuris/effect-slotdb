import { describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import { canonicalizeAst } from './operations.ts'
import { openLiterals, openMembersIn, type Unrecognized } from './open-literals.ts'

const Mood = openLiterals(['calm', 'busy'])
const decode = Schema.decodeUnknownSync(Mood)
const encode = Schema.encodeUnknownSync(Mood)

const fingerprintOf = (schema: Schema.Top): string =>
  canonicalizeAst(SchemaAST.toEncoded(schema.ast))

// The inferred type includes declared literals and Unrecognized, but not plain strings.
type MoodType = typeof Mood.Type
const _declared: MoodType = {} as 'calm' | 'busy' | Unrecognized
const _exact: 'calm' | 'busy' | Unrecognized = {} as MoodType
// @ts-expect-error plain strings require decoding before assignment
const _plain: MoodType = 'tense' as string

describe('an open literal union', () => {
  it('decodes a declared member', () => {
    expect(decode('calm')).toBe('calm')
  })

  it('decodes an undeclared member unchanged', () => {
    expect(decode('tense')).toBe('tense')
  })

  it('encodes an unrecognized member unchanged', () => {
    expect(encode(decode('tense'))).toBe('tense')
  })

  it('accepts a value at the maximum length', () => {
    expect(decode('x'.repeat(64))).toBe('x'.repeat(64))
  })

  it.each([
    ['an empty string', ''],
    ['a control character', 'a\u0000b'],
    ['a zero-width character', 'a\u200bb'],
    ['a value above the maximum length', 'x'.repeat(65)],
    ['a number', 1],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(() => decode(value)).toThrow()
  })

  it('checks stored values against a custom pattern', () => {
    const DateFormat = openLiterals(['dd/MM/yyyy'], { pattern: /^[dMy/.\u2011]{1,16}$/u })
    const decodeFormat = Schema.decodeUnknownSync(DateFormat)
    expect(decodeFormat('yyyy.MM.dd')).toBe('yyyy.MM.dd')
    expect(() => decodeFormat('calm')).toThrow()
  })

  it('rejects a member that does not match the storage pattern', () => {
    expect(() => openLiterals(['ok', 'not ok'], { pattern: /^[a-z]+$/ })).toThrow(/'not ok'/)
  })

  it('rejects an empty member list', () => {
    expect(() => openLiterals([])).toThrow()
  })

  it('rejects duplicate members', () => {
    expect(() => openLiterals(['calm', 'calm'])).toThrow(/once/)
  })
})

describe('the fingerprint of an open literal union', () => {
  // The fingerprint stores the pattern as a JSON string.
  const DEFAULT = JSON.stringify(`${/^[^\p{Cc}\p{Cf}]{1,64}$/u}`)

  it('renders the pattern and sorted members with an open marker', () => {
    expect(fingerprintOf(Mood)).toBe(`open${DEFAULT}("busy"|"calm")`)
  })

  it('keeps the marker inside a nullable wrapper', () => {
    expect(fingerprintOf(Schema.NullOr(Mood))).toBe(`(Null|open${DEFAULT}("busy"|"calm"))`)
  })

  it('differs from a closed union of the same members', () => {
    expect(fingerprintOf(Mood)).not.toBe(fingerprintOf(Schema.Literals(['calm', 'busy'])))
  })

  it('differs when the storage pattern differs', () => {
    const narrower = openLiterals(['calm', 'busy'], { pattern: /^[a-z]{1,8}$/ })
    expect(fingerprintOf(narrower)).not.toBe(fingerprintOf(Mood))
  })

  it('treats an unmarked union of literals and String as closed', () => {
    const handWritten = Schema.Union([Schema.Literals(['calm', 'busy']), Schema.String])
    expect(fingerprintOf(handWritten)).toBe('(("busy"|"calm")|String)')
  })
})

describe('the members a stored field declares', () => {
  const membersOf = (schema: Schema.Top) => openMembersIn(SchemaAST.toEncoded(schema.ast))

  it('reads through nested nullable and optional wrappers', () => {
    expect(membersOf(Schema.NullOr(Schema.UndefinedOr(Mood)))).toEqual(['calm', 'busy'])
  })

  it('returns undefined for a closed union', () => {
    expect(membersOf(Schema.Literals(['calm', 'busy']))).toBeUndefined()
  })
})
