import { describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import {
  blocksRegeneration,
  checkChain,
  checkDrift,
  checkLockfile,
  parseLockfile,
} from './checks.ts'
import { fieldIdOf } from './ids.ts'
import { openLiterals } from './open-literals.ts'
import {
  addOptional,
  addRequired,
  migrateSchema,
  mergeFields,
  remove,
  rename,
  retype,
  seed,
} from './operations.ts'
import { shapeOf, SchemaIndex } from './schema-index.ts'
import { Migration } from './migration.ts'
import { FIXTURE_INDEX } from '../testing.ts'

const Document = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  size: Schema.Number,
})

const base = { file: '0000', entities: { document: seed(Document) } } satisfies Migration

/** The base schema with field IDs assigned for operations that require IDs. */
const stamped = shapeOf([base], 'document')

const chainOf = (...rest: readonly Migration[]): readonly Migration[] => [base, ...rest]

describe('lockfile serialization and parsing', () => {
  it('parses every recorded field fingerprint', () => {
    const index = new SchemaIndex(chainOf())
    const parsed = parseLockfile(index.lockfile())

    for (const entity of index.entities.values()) {
      const fields = parsed.get(entity.id)
      expect(fields, entity.table).toBeDefined()
      for (const field of entity.fieldsById.values()) {
        expect(fields!.get(field.id), field.birthName).toBe(field.fingerprint)
      }
    }
  })

  it('reports no drift for a current lockfile', () => {
    const index = new SchemaIndex(chainOf())
    expect(checkDrift(parseLockfile(index.lockfile()), index)).toEqual([])
  })

  it('parses a literal containing tabs, quotes, and union punctuation', () => {
    const index = new SchemaIndex([
      {
        file: '0000',
        entities: {
          document: seed(
            Schema.Struct({ id: Schema.String, mark: Schema.Literals(['a\tb|"(c)', 'd']) }),
          ),
        },
      },
    ])
    expect(checkDrift(parseLockfile(index.lockfile()), index)).toEqual([])
  })
})

describe('value drift', () => {
  const previous = parseLockfile(new SchemaIndex(chainOf()).lockfile())

  it('reports no drift when a field is appended', () => {
    const appended = new SchemaIndex(
      chainOf({
        file: '0001',
        entities: { document: migrateSchema(stamped, addOptional('notes', Schema.String)) },
      }),
    )
    expect(checkDrift(previous, appended)).toEqual([])
  })

  it('detects a changed stored type under the same ID', () => {
    // Changing a stored type requires a retype rather than an edit to the base migration.
    const edited = new SchemaIndex([
      {
        file: '0000',
        entities: {
          document: seed(
            Schema.Struct({ id: Schema.String, title: Schema.Number, size: Schema.Number }),
          ),
        },
      },
    ])

    const found = checkDrift(previous, edited)
    expect(found).toHaveLength(1)
    expect(found[0].code).toBe('value-drift')
    expect(found[0].message).toContain(fieldIdOf('title', '0000'))
  })

  it('detects a changed merge policy under the same ID', () => {
    const repolicied = new SchemaIndex([
      {
        file: '0000',
        entities: {
          document: seed(
            Schema.Struct({
              id: Schema.String,
              title: Schema.String.annotate({ merge: 'fww' }),
              size: Schema.Number,
            }),
          ),
        },
      },
    ])

    const found = checkDrift(previous, repolicied)
    expect(found).toHaveLength(1)
    expect(found[0].code).toBe('value-drift')
  })

  it('detects a renamed literal under the same ID', () => {
    const withStatus = (status: Schema.Top) =>
      new SchemaIndex([
        {
          file: '0000',
          entities: { document: seed(Schema.Struct({ id: Schema.String, status })) },
        },
      ])
    const committed = parseLockfile(withStatus(Schema.Literals(['Skipped', 'Done'])).lockfile())

    const found = checkDrift(committed, withStatus(Schema.Literals(['Snoozed', 'Done'])))
    expect(found).toHaveLength(1)
    expect(found[0].code).toBe('value-drift')
    expect(found[0].message).toContain(fieldIdOf('status', '0000'))
  })

  it('accepts a retype with a new ID for the new stored type', () => {
    const retyped = new SchemaIndex(
      chainOf({
        file: '0001',
        entities: {
          document: migrateSchema(stamped, retype('title', Schema.Number, { encodeToOld: String })),
        },
      }),
    )
    expect(checkDrift(previous, retyped)).toEqual([])
  })

  it('detects a field deleted from the chain', () => {
    const vanished = new SchemaIndex([
      { file: '0000', entities: { document: seed(Schema.Struct({ id: Schema.String })) } },
    ])

    const codes = checkDrift(previous, vanished).map(d => d.code)
    expect(codes).toContain('vanished-field')
  })

  it('accepts a removed field whose retired ID remains in the chain', () => {
    const removed = new SchemaIndex(
      chainOf({ file: '0001', entities: { document: migrateSchema(stamped, remove('title')) } }),
    )
    expect(checkDrift(previous, removed)).toEqual([])
  })
})

describe('an open literal union under the same ID', () => {
  const withMood = (mood: Schema.Top) =>
    new SchemaIndex([
      { file: '0000', entities: { document: seed(Schema.Struct({ id: Schema.String, mood })) } },
    ])
  const committed = withMood(openLiterals(['calm', 'busy'])).lockfile()
  const driftAgainst = (mood: Schema.Top) =>
    checkDrift(parseLockfile(committed), withMood(mood)).map(d => d.code)

  it('accepts an added member', () => {
    expect(driftAgainst(openLiterals(['calm', 'busy', 'tense']))).toEqual([])
  })

  it('requires only lockfile regeneration when a member is added', () => {
    const problems = checkLockfile(withMood(openLiterals(['calm', 'busy', 'tense'])), committed)
    expect(problems.map(p => p.code)).toContain('stale-lockfile')
    expect(problems.some(blocksRegeneration)).toBe(false)
  })

  it('detects a removed member', () => {
    expect(driftAgainst(openLiterals(['calm']))).toEqual(['value-drift'])
  })

  it('detects a renamed member', () => {
    expect(driftAgainst(openLiterals(['calm', 'hectic']))).toEqual(['value-drift'])
  })

  it('detects a changed merge policy alongside an added member', () => {
    const repolicied = openLiterals(['calm', 'busy', 'tense']).annotate({ merge: 'fww' })
    expect(driftAgainst(repolicied)).toEqual(['value-drift'])
  })

  it('detects a change from an open union to a closed union', () => {
    expect(driftAgainst(Schema.Literals(['calm', 'busy']))).toEqual(['value-drift'])
  })

  it('detects a change from a closed union to an open union', () => {
    const closed = withMood(Schema.Literals(['calm', 'busy'])).lockfile()
    const opened = withMood(openLiterals(['calm', 'busy']))
    expect(checkDrift(parseLockfile(closed), opened).map(d => d.code)).toEqual(['value-drift'])
  })

  it('detects a changed storage pattern', () => {
    const narrower = openLiterals(['calm', 'busy'], { pattern: /^[a-z]{1,8}$/ })
    expect(driftAgainst(narrower)).toEqual(['value-drift'])
  })

  it('accepts an added member inside a nullable wrapper', () => {
    const before = withMood(Schema.NullOr(openLiterals(['calm', 'busy']))).lockfile()
    const after = withMood(Schema.NullOr(openLiterals(['calm', 'busy', 'tense'])))
    expect(checkDrift(parseLockfile(before), after)).toEqual([])
  })

  it('parses members containing quotes, pipes, and the open marker', () => {
    const tricky = ['a|b', 'say "hi"', 'open"x"("y")']
    const before = withMood(openLiterals(tricky)).lockfile()
    const driftFrom = (mood: Schema.Top) =>
      checkDrift(parseLockfile(before), withMood(mood)).map(d => d.code)

    expect(driftFrom(openLiterals([...tricky, 'c']))).toEqual([])
    expect(driftFrom(openLiterals(['a|b', 'open"x"("y")']))).toEqual(['value-drift'])
  })
})

describe('draft renames', () => {
  it('flags a remove and an add of the same stored type in one migration', () => {
    const found = checkChain(
      chainOf({
        file: '0001',
        entities: {
          document: migrateSchema(stamped, remove('title'), addOptional('name', Schema.String)),
        },
      }),
    )

    expect(found.map(d => d.code)).toContain('draft-rename')
    expect(found[0].message).toContain('0001')
  })

  it('compares stored types regardless of optionality', () => {
    // Ignore optionality when checking for a replacement with the same stored type.
    const optional = checkChain(
      chainOf({
        file: '0001',
        entities: {
          document: migrateSchema(stamped, remove('title'), addOptional('name', Schema.String)),
        },
      }),
    )
    const required = checkChain(
      chainOf({
        file: '0001',
        entities: {
          document: migrateSchema(
            stamped,
            remove('title'),
            addRequired('name', Schema.String, () => ''),
          ),
        },
      }),
    )

    expect(optional.map(d => d.code)).toContain('draft-rename')
    expect(required.map(d => d.code)).toContain('draft-rename')
  })

  it('reports no rename when stored types differ', () => {
    // Different stored types do not indicate a rename.
    const found = checkChain(
      chainOf({
        file: '0001',
        entities: {
          document: migrateSchema(stamped, remove('title'), addOptional('count', Schema.Number)),
        },
      }),
    )
    expect(found).toEqual([])
  })

  it('reports no rename across separate migrations', () => {
    const dropped = {
      file: '0001',
      entities: { document: migrateSchema(stamped, remove('title')) },
    } satisfies Migration

    const found = checkChain(
      chainOf(dropped, {
        file: '0002',
        entities: {
          document: migrateSchema(
            shapeOf([base, dropped], 'document'),
            addOptional('name', Schema.String),
          ),
        },
      }),
    )
    expect(found).toEqual([])
  })

  it('reports no problem for a declared rename', () => {
    const found = checkChain(
      chainOf({
        file: '0001',
        entities: { document: migrateSchema(stamped, rename('title', 'name')) },
      }),
    )
    expect(found).toEqual([])
  })

  it('reports no problem for a declared retype', () => {
    const found = checkChain(
      chainOf({
        file: '0001',
        entities: {
          document: migrateSchema(stamped, retype('title', Schema.String, { encodeToOld: s => s })),
        },
      }),
    )
    expect(found).toEqual([])
  })
})

describe('read-only derived fields', () => {
  const merged = (split?: (v: any) => readonly [any, any]) =>
    chainOf({
      file: '0001',
      entities: {
        document: migrateSchema(
          stamped,
          mergeFields(['id', 'title'], 'label', Schema.String, {
            combine: (a, b) => `${a} ${b}`,
            split,
          }),
        ),
      },
    })

  it('flags a merge target with no split', () => {
    const found = checkChain(merged())
    expect(found.map(d => d.code)).toContain('read-only-derived')
    expect(found[0].message).toContain('label')
  })

  it('reports no problem for a writable derived target', () => {
    expect(checkChain(merged(v => [String(v), String(v)]))).toEqual([])
  })
})

describe('the fixture chain', () => {
  it('passes every check, including the entity that declares only keys', () => {
    expect(checkChain(FIXTURE_INDEX.chain)).toEqual([])
  })
})

describe('a chain against its committed lockfile', () => {
  const codesFor = (index: SchemaIndex, committed?: string) =>
    checkLockfile(index, committed).map(problem => problem.code)

  /** A rendered identity lockfile with a trailing newline. */
  const committedFor = (index: SchemaIndex) => `${index.lockfile()}\n`

  it('reports no problem when the committed lockfile matches the chain', () => {
    expect(codesFor(FIXTURE_INDEX, committedFor(FIXTURE_INDEX))).toEqual([])
  })

  it('reports a missing lockfile', () => {
    expect(codesFor(FIXTURE_INDEX)).toContain('missing-lockfile')
  })

  it('reports a stale lockfile after a field addition and permits regeneration', () => {
    const grown = new SchemaIndex(
      chainOf({
        file: '0001',
        entities: { document: migrateSchema(stamped, addOptional('summary', Schema.String)) },
      }),
    )
    const problems = checkLockfile(grown, committedFor(new SchemaIndex(chainOf())))
    const codes = problems.map(problem => problem.code)
    // Regeneration corrects stale text and missing fingerprints when field IDs match.
    expect(codes).toContain('stale-lockfile')
    expect(codes).toContain('unrecorded-field')
    expect(problems.filter(blocksRegeneration)).toEqual([])
  })

  it('rejects a changed stored type under the same ID', () => {
    // A retype in a new migration assigns a new ID and preserves the retired ID.
    const edited = new SchemaIndex([
      {
        file: '0000',
        entities: {
          document: seed(
            Schema.Struct({ id: Schema.String, title: Schema.Number, size: Schema.Number }),
          ),
        },
      },
    ])
    const codes = checkLockfile(edited, committedFor(new SchemaIndex(chainOf())))
      .filter(blocksRegeneration)
      .map(problem => problem.code)
    // Regeneration must retain the fingerprint that identifies the incompatible type
    // change.
    expect(codes).toContain('value-drift')
  })

  it('detects changes to a valid lockfile', () => {
    const index = new SchemaIndex(chainOf())
    const gutted = committedFor(index)
      .split('\n')
      .filter(line => !line.includes('title'))
      .join('\n')
    expect(codesFor(index, gutted)).toContain('unrecorded-field')
  })
})
