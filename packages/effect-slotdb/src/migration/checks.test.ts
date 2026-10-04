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

/** The base shape with its ids stamped, which the id-reading operations need. */
const stamped = shapeOf([base], 'document')

const chainOf = (...rest: readonly Migration[]): readonly Migration[] => [base, ...rest]

describe('the lockfile round-trips', () => {
  it('parses back the fingerprint of every field it emitted', () => {
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

  it('reports drift against nothing when the lockfile is current', () => {
    const index = new SchemaIndex(chainOf())
    expect(checkDrift(parseLockfile(index.lockfile()), index)).toEqual([])
  })
})

describe('value drift', () => {
  const previous = parseLockfile(new SchemaIndex(chainOf()).lockfile())

  it('is silent when a field is appended', () => {
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

  it('accepts a retype with a new ID for the new stored type', () => {
    const retyped = new SchemaIndex(
      chainOf({
        file: '0001',
        entities: { document: migrateSchema(stamped, retype('title', Schema.Number)) },
      }),
    )
    expect(checkDrift(previous, retyped)).toEqual([])
  })

  it('catches a field edited out of the chain entirely', () => {
    const vanished = new SchemaIndex([
      { file: '0000', entities: { document: seed(Schema.Struct({ id: Schema.String })) } },
    ])

    const codes = checkDrift(previous, vanished).map(d => d.code)
    expect(codes).toContain('vanished-field')
  })

  it('does not confuse a removal with a vanishing, since a removed id is retained', () => {
    const removed = new SchemaIndex(
      chainOf({ file: '0001', entities: { document: migrateSchema(stamped, remove('title')) } }),
    )
    expect(checkDrift(previous, removed)).toEqual([])
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

  it('sees through optionality, which is how the mistake is usually written', () => {
    // Compare stored types without optionality so adding an optional replacement is
    // detected.
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
        entities: { document: migrateSchema(stamped, retype('title', Schema.String)) },
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

  it('reports an absent lockfile rather than treating it as agreement', () => {
    expect(codesFor(FIXTURE_INDEX)).toContain('missing-lockfile')
  })

  it('catches a lockfile left behind by a chain that grew, and lets it be rewritten', () => {
    const grown = new SchemaIndex(
      chainOf({
        file: '0001',
        entities: { document: migrateSchema(stamped, addOptional('summary', Schema.String)) },
      }),
    )
    const problems = checkLockfile(grown, committedFor(new SchemaIndex(chainOf())))
    const codes = problems.map(problem => problem.code)
    // Regeneration fixes stale text and missing fingerprints without an identity
    // conflict.
    expect(codes).toContain('stale-lockfile')
    expect(codes).toContain('unrecorded-field')
    expect(problems.filter(blocksRegeneration)).toEqual([])
  })

  it('rejects a changed stored type under the same ID', () => {
    // Retyping in a new migration would assign a new ID instead of changing the old ID.
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

  it('catches a hand-edited lockfile that still parses', () => {
    const index = new SchemaIndex(chainOf())
    const gutted = committedFor(index)
      .split('\n')
      .filter(line => !line.includes('title'))
      .join('\n')
    expect(codesFor(index, gutted)).toContain('unrecorded-field')
  })
})
