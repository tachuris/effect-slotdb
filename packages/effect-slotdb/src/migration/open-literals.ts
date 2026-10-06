import type * as Brand from 'effect/Brand'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'

const UNRECOGNIZED = '@tachuris/effect-slotdb/Unrecognized'

// Record the pattern on the storage check because `toEncoded` retains check
// annotations but removes brands.
const OPEN_PATTERN = '@tachuris/effect-slotdb/openPattern'

// Identifies an open literal union in a fingerprint before the quoted pattern.
const OPEN_MARKER = 'open'

/** A string accepted by an open literal union but not declared by this build. */
export type Unrecognized = string & Brand.Brand<typeof UNRECOGNIZED>

/** A literal union that decodes undeclared members as {@link Unrecognized}. */
export type OpenLiterals<L extends ReadonlyArray<string>> = Schema.Union<
  readonly [Schema.Literals<L>, Schema.brand<Schema.String, typeof UNRECOGNIZED>]
>

/** The declared members and storage pattern of an open literal union. */
interface OpenUnion {
  readonly members: ReadonlyArray<string>
  readonly pattern: string
}

/** A fingerprint with the members of each open union removed from its text. */
interface OpenShape {
  readonly skeleton: string
  readonly groups: ReadonlyArray<ReadonlySet<string>>
}

// Allow unassigned code points so peers with older Unicode tables accept newly
// assigned characters. Exclude control and format characters.
const DEFAULT_PATTERN = /^[^\p{Cc}\p{Cf}]{1,64}$/u

/**
 * Declares string members that later builds can extend under the same field ID.
 * Undeclared strings that match `pattern` decode as {@link Unrecognized}.
 */
export const openLiterals = <const L extends ReadonlyArray<string>>(
  members: L,
  options?: { readonly pattern?: RegExp },
): OpenLiterals<L> => {
  if (members.length === 0) throw new Error('openLiterals: declare at least one member')
  if (new Set(members).size !== members.length) {
    throw new Error('openLiterals: declare each member once')
  }

  const pattern = options?.pattern ?? DEFAULT_PATTERN
  const stored = Schema.String.check(Schema.isPattern(pattern, { [OPEN_PATTERN]: `${pattern}` }))
  // Use a boolean return type because a type guard narrows rejected members to never.
  const storable: (value: string) => boolean = Schema.is(stored)
  for (const member of members) {
    if (!storable(member)) {
      throw new Error(`openLiterals: member '${member}' does not match the storage pattern`)
    }
  }

  return Schema.Union([Schema.Literals(members), stored.pipe(Schema.brand(UNRECOGNIZED))])
}

/** Returns declared open literal members, including inside nested unions. */
export const openMembersIn = (encoded: SchemaAST.AST): ReadonlyArray<string> | undefined => {
  const open = openUnionOf(encoded)
  if (open !== undefined) return open.members
  if (!SchemaAST.isUnion(encoded)) return undefined
  for (const type of encoded.types) {
    const nested = openMembersIn(type)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** Recognizes string literals combined with one marked `String` as an open union. */
const openUnionOf = (ast: SchemaAST.AST): OpenUnion | undefined => {
  if (!SchemaAST.isUnion(ast)) return undefined

  const members: Array<string> = []
  let pattern: string | undefined
  for (const type of ast.types) {
    const marked = SchemaAST.isString(type) ? openPatternOf(type) : undefined
    if (marked !== undefined) {
      if (pattern !== undefined) return undefined
      pattern = marked
      continue
    }
    for (const literal of SchemaAST.isUnion(type) ? type.types : [type]) {
      if (!SchemaAST.isLiteral(literal) || typeof literal.literal !== 'string') return undefined
      members.push(literal.literal)
    }
  }
  return pattern === undefined || members.length === 0 ? undefined : { members, pattern }
}

/** Returns the pattern recorded by {@link openLiterals}, or undefined if absent. */
const openPatternOf = (ast: SchemaAST.String): string | undefined => {
  for (const check of ast.checks ?? []) {
    const pattern = check.annotations?.[OPEN_PATTERN]
    if (typeof pattern === 'string') return pattern
  }
  return undefined
}

/**
 * Renders an open literal union as `open"<pattern>"("a"|"b")`.
 * Quotes and sorts members. Returns undefined for other nodes.
 */
export const openFingerprintOf = (ast: SchemaAST.AST): string | undefined => {
  const open = openUnionOf(ast)
  if (open === undefined) return undefined
  const members = open.members.map(member => JSON.stringify(member)).sort()
  return `${OPEN_MARKER}${JSON.stringify(open.pattern)}(${members.join('|')})`
}

/**
 * Checks that `next` changes only the member lists of open literal unions by adding
 * members or leaving the lists unchanged. Existing stored values remain valid.
 */
export const widensOpenUnions = (previous: string, next: string): boolean => {
  const before = openShapeOf(previous)
  const after = openShapeOf(next)
  if (before === undefined || after === undefined) return false
  return (
    before.skeleton === after.skeleton &&
    before.groups.every((members, i) => [...members].every(member => after.groups[i].has(member)))
  )
}

/**
 * Separates open union members from the remaining fingerprint text, including patterns.
 * Returns undefined when an open union lacks an opening or closing parenthesis.
 */
const openShapeOf = (fingerprint: string): OpenShape | undefined => {
  let skeleton = ''
  const groups: Array<Set<string>> = []
  let i = 0

  while (i < fingerprint.length) {
    if (fingerprint.startsWith(`${OPEN_MARKER}"`, i)) {
      const patternEnd = quotedEnd(fingerprint, i + OPEN_MARKER.length)
      skeleton += fingerprint.slice(i, patternEnd)
      i = patternEnd
      if (fingerprint[i] !== '(') return undefined
      i += 1

      const members = new Set<string>()
      while (fingerprint[i] === '"') {
        const end = quotedEnd(fingerprint, i)
        members.add(JSON.parse(fingerprint.slice(i, end)) as string)
        i = fingerprint[end] === '|' ? end + 1 : end
      }
      if (fingerprint[i] !== ')') return undefined
      i += 1
      groups.push(members)
      skeleton += '()'
      continue
    }
    // Copy quoted literals unchanged so marker text inside a literal is not parsed.
    const end = fingerprint[i] === '"' ? quotedEnd(fingerprint, i) : i + 1
    skeleton += fingerprint.slice(i, end)
    i = end
  }

  return { skeleton, groups }
}

/** Returns the index after the JSON string that begins at `start`. */
const quotedEnd = (text: string, start: number): number => {
  let i = start + 1
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
  return i + 1
}
