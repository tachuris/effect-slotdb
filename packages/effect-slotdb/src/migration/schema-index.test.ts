import { describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import * as SchemaTransformation from 'effect/SchemaTransformation'
import { FIXTURE_INDEX } from '../testing.ts'
import { annotationsOf } from './annotations.ts'
import { entityIdOf, fieldIdOf, EntityId, FieldId } from './ids.ts'
import {
  addOptional,
  canonicalizeAst,
  migrateSchema,
  fieldsOf,
  mergeFields,
  promote,
  recodec,
  remove,
  rename,
  retype,
  seed,
} from './operations.ts'
import { key, unique } from './fields.ts'
import { Migration } from './migration.ts'
import { SchemaIndex, shapeOf } from './schema-index.ts'

const m0000 = SchemaIndex.seed({
  file: '0000',
  entities: {
    infrequent: seed(Schema.Struct({ id: Schema.String })),
    document: seed(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        firstName: Schema.String,
        lastName: Schema.String,
      }),
    ),
  },
})

type Document0000 = typeof m0000.schemas.document.Type
const _document0000: {
  readonly id: string
  readonly title: string
  readonly firstName: string
  readonly lastName: string
} = {} as Document0000

const m0001 = m0000.appendMigration({
  file: '0001',
  entities: {
    document: migrateSchema(m0000.schemas.document, addOptional('description', Schema.String)),
  },
})

type Document0001 = typeof m0001.schemas.document.Type
const _document0001: {
  readonly id: string
  readonly title: string
  readonly firstName: string
  readonly lastName: string
  readonly description?: string
} = {} as Document0001

const m0002 = m0001.appendMigration({
  file: '0002',
  entities: { document: migrateSchema(m0001.schemas.document, rename('title', 'name')) },
})

type Document0002 = typeof m0002.schemas.document.Type
const _document0002: {
  readonly id: string
  readonly name: string
  readonly firstName: string
  readonly lastName: string
  readonly description?: string
} = {} as Document0002

const m0003 = m0002.appendMigration({
  file: '0003',
  entities: {
    document: migrateSchema(
      m0002.schemas.document,
      mergeFields(['firstName', 'lastName'], 'fullName', Schema.String, {
        combine: (a, b) => `${a} ${b}`,
        split: (v: string) => {
          const at = String(v).indexOf(' ')
          return at === -1 ? [v, ''] : [String(v).slice(0, at), String(v).slice(at + 1)]
        },
      }),
    ),
  },
})

type Document0003 = typeof m0003.schemas.document.Type
const _document0003: {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly fullName: string
} = {} as Document0003

const m0004 = m0003.appendMigration({
  file: '0004',
  entities: {
    infrequent: migrateSchema(m0003.schemas.infrequent, addOptional('enabled', Schema.Boolean)),
    document: migrateSchema(
      m0003.schemas.document,
      remove('description'),
      addOptional('notes', Schema.String),
    ),
  },
})

type Document0004 = typeof m0004.schemas.document.Type
const _document0004: {
  readonly id: string
  readonly name: string
  readonly fullName: string
  readonly notes?: string
} = {} as Document0004

const schemaIndex = m0004

const upto = (n: number) => new SchemaIndex(schemaIndex.chain.slice(0, n))
const doc = (n: number) => upto(n).byName.get('document')!

describe('annotations remain after schema operations', () => {
  // Renaming must preserve the field ID annotation.
  const Base = Schema.Struct({
    id: Schema.String.annotate({ fieldId: FieldId.make('0000000000000001') }),
    title: Schema.String.annotate({ fieldId: FieldId.make('0000000000000002') }),
  })

  const idsOf = (schema: Schema.Top): Map<string, unknown> => {
    const ast = SchemaAST.toType(schema.ast)
    if (!SchemaAST.isObjects(ast)) throw new Error('expected an objects AST')
    return new Map(
      (ast as any).propertySignatures.map((ps: any) => [
        String(ps.name),
        ps.type.annotations?.fieldId,
      ]),
    )
  }

  it('rename preserves a field ID under the new name', () => {
    const ids = idsOf(Base.pipe(rename('title', 'name')))
    expect(ids.get('name')).toBe('0000000000000002')
    expect(ids.has('title')).toBe(false)
  })

  it('a new field has no ID before derivation', () => {
    expect(annotationsOf(Schema.String).fieldId).toBeUndefined()
    expect(idsOf(Base.pipe(addOptional('notes', Schema.String))).get('notes')).toBeUndefined()
  })

  it('an annotation does not perturb the shape', () => {
    const plain = Schema.Struct({ a: Schema.String })
    const annotated = Schema.Struct({
      a: Schema.String.annotate({ fieldId: FieldId.make('0000000000000009') }),
    })
    expect(canonicalizeAst(plain.ast)).toBe(canonicalizeAst(annotated.ast))
  })

  it('reads a decodeTo through to its target, which is where a recodec puts the id', () => {
    // Read target annotations to avoid assigning a new ID to an unchanged stored type.
    const source = (Schema.String as any).annotate({ fieldId: 'source-id' })
    const target = (Schema.Number as any).annotate({ fieldId: 'target-id' })
    const recoded = source.pipe(
      Schema.decodeTo(
        target,
        SchemaTransformation.transform({ decode: Number, encode: String }) as any,
      ),
    )
    expect(annotationsOf(recoded).fieldId).toBe('target-id')
  })
})

describe('ids are derived, never authored', () => {
  it('two peers on different chain prefixes agree on shared ids', () => {
    // Peers use different field names after a rename but address the same field ID.
    const early = doc(2)
    const late = doc(5)
    expect(early.liveFieldIds.get('title')).toBe(late.liveFieldIds.get('name'))
    expect(early.liveFieldIds.get('id')).toBe(late.liveFieldIds.get('id'))
    expect(early.liveFieldIds.has('name')).toBe(false)
  })

  it('a rename preserves the original field ID', () => {
    expect(doc(5).liveFieldIds.get('name')).toBe(fieldIdOf('title', '0000'))
  })

  it('reusing a removed name assigns a new field ID', () => {
    const readded = schemaIndex
      .appendMigration({
        file: '0005',
        entities: {
          document: migrateSchema(doc(5).schema, addOptional('description', Schema.String)),
        },
      })
      .byName.get('document')!

    const first = fieldIdOf('description', '0001')
    const second = fieldIdOf('description', '0005')
    expect(second).not.toBe(first)
    expect(readded.retiredFields.has(first)).toBe(true)
    expect(readded.liveFieldIds.get('description')).toBe(second)
  })
})

describe('entities', () => {
  const renamed = schemaIndex.appendMigration({
    file: '0005',
    renameEntity: { document: 'record' },
  })

  // Entity renames must preserve field types for subsequent migration operations.
  type Record0005 = typeof renamed.schemas.record.Type
  const _record0005: {
    readonly id: string
    readonly name: string
    readonly fullName: string
    readonly notes?: string
  } = {} as Record0005

  // Check the complete key set to detect a rename widened to a string index signature.
  const _renamedKeys: 'infrequent' | 'record' = {} as keyof typeof renamed.schemas

  // An entity the file does not rename keeps its name and its shape.
  const _untouched: { readonly id: string; readonly enabled?: boolean } =
    {} as typeof renamed.schemas.infrequent.Type

  it('drops the old name from the schemas it derives', () => {
    // @ts-expect-error
    const _gone: unknown = renamed.schemas.document
    expect(renamed.byName.has('document')).toBe(false)
  })

  it('renaming an entity preserves the ID derived from its original name', () => {
    const entity = renamed.byName.get('record')!
    expect(entity.id).toBe(entityIdOf('document'))
    expect(entity.liveFieldIds.get('name')).toBe(doc(5).liveFieldIds.get('name'))
  })

  it('a renamed entity keeps every field id underneath it', () => {
    const before = doc(5)
    const after = renamed.byName.get('record')!
    expect([...after.fieldsById.keys()].sort()).toEqual([...before.fieldsById.keys()].sort())
  })

  it('refuses to rename an entity that does not exist', () => {
    expect(() => new SchemaIndex([{ file: '0000', renameEntity: { ghost: 'other' } }])).toThrow(
      /rename of unknown entity/,
    )
  })

  it('derives a table name from the birth name', () => {
    expect(renamed.byName.get('record')!.table).toBe('document')
  })
})

describe('appending a file to a chain', () => {
  const born = {
    file: '0000',
    entities: { document: seed(Schema.Struct({ id: Schema.String })) },
  } satisfies Migration

  const first = SchemaIndex.seed(born)

  const later = {
    file: '0001',
    entities: {
      document: migrateSchema(first.schemas.document, addOptional('notes', Schema.String)),
    },
  } satisfies Migration

  const second = first.appendMigration(later)

  const _document: { readonly id: string; readonly notes?: string } =
    {} as typeof second.schemas.document.Type

  it('returns the chain with the file on the end, in order', () => {
    expect(second.chain).toEqual([born, later])
  })

  it('reads the shapes at that point, so the next file can seed from them', () => {
    expect(Object.keys(fieldsOf(second.schemas.document))).toEqual(['id', 'notes'])
  })

  it('leaves the chain it was given alone', () => {
    expect(first.chain).toEqual([born])
  })

  it('starts from nothing, which is how the first file gets appended', () => {
    expect(Object.keys(fieldsOf(first.schemas.document))).toEqual(['id'])
  })
})

describe('columns are append-only', () => {
  it('a plain birth name claims a plain column, and a rename does not move it', () => {
    const entity = doc(5)
    expect(entity.fieldsById.get(entity.liveFieldIds.get('name')!)!.column).toBe('title')
  })

  it('a second claimant on a name gets a suffix, and the first keeps its column', () => {
    const readded = schemaIndex
      .appendMigration({
        file: '0005',
        entities: {
          document: migrateSchema(doc(5).schema, addOptional('description', Schema.String)),
        },
      })
      .byName.get('document')!

    expect(readded.fieldsById.get(fieldIdOf('description', '0001'))!.column).toBe('description')
    expect(readded.fieldsById.get(fieldIdOf('description', '0005'))!.column).toMatch(
      /^description_[0-9a-f]{8}$/,
    )
  })

  it('a removed field keeps its column and its ledger entry', () => {
    const removed = doc(5).fieldsById.get(fieldIdOf('description', '0001'))!
    expect(removed.column).toBe('description')
    expect(removed.currentName).toBeUndefined()
    expect(doc(5).retiredFields.has(removed.id)).toBe(true)
  })
})

describe('merge', () => {
  it('demotes its sources without retiring them', () => {
    const entity = doc(5)
    const first = fieldIdOf('firstName', '0000')
    expect(entity.syncedSources.has(first)).toBe(true)
    expect(entity.retiredFields.has(first)).toBe(false)
    expect(entity.liveFieldIds.has('firstName')).toBe(false)
  })

  it('records its sources and its projection on the target', () => {
    const entity = doc(5)
    const target = entity.fieldsById.get(entity.liveFieldIds.get('fullName')!)!
    expect(target.kind).toBe('derived')
    expect(target.derivedFrom).toEqual([
      fieldIdOf('firstName', '0000'),
      fieldIdOf('lastName', '0000'),
    ])
    expect(target.combine!('Ada', 'Lovelace')).toBe('Ada Lovelace')
    expect(target.split!('Ada Lovelace')).toEqual(['Ada', 'Lovelace'])
    expect(target.writable).toBe(true)
  })

  it('marks a target with no split as unwritable', () => {
    const noSplit = m0000
      .appendMigration({
        file: '0001',
        entities: {
          document: migrateSchema(
            m0000.schemas.document,
            mergeFields(['firstName', 'lastName'], 'fullName', Schema.String, {
              combine: (a, b) => `${a} ${b}`,
            }),
          ),
        },
      })
      .byName.get('document')!

    expect(noSplit.fieldsById.get(noSplit.liveFieldIds.get('fullName')!)!.writable).toBe(false)
  })

  it('refuses to merge a field the shape does not hold', () => {
    // Runtime validation also checks operations whose field names are absent from static types.
    const born = { file: '0000', entities: { document: seed(Schema.Struct({ a: Schema.String })) } }

    expect(
      () =>
        new SchemaIndex([
          born,
          {
            file: '0001',
            entities: {
              document: migrateSchema(
                shapeOf([born], 'document'),
                // @ts-expect-error
                mergeFields(['a', 'missing'], 'merged', Schema.String, { combine: a => a }),
              ),
            },
          },
        ]),
    ).toThrow(/unknown field/)
  })
})

describe('recodec keeps identity, retype replaces it', () => {
  const recoded = schemaIndex
    .appendMigration({
      file: '0005',
      entities: {
        document: migrateSchema(
          doc(5).schema,
          recodec('notes', Schema.Number, {
            decode: (s: string) => Number(s),
            encode: (n: number) => String(n),
          }),
        ),
      },
    })
    .byName.get('document')!

  const retyped = schemaIndex
    .appendMigration({
      file: '0005',
      entities: { document: migrateSchema(doc(5).schema, retype('notes', Schema.Number)) },
    })
    .byName.get('document')!

  it('recodec leaves the id, the column, and the encoded fingerprint alone', () => {
    const before = doc(5).fieldsById.get(fieldIdOf('notes', '0004'))!
    const after = recoded.fieldsById.get(fieldIdOf('notes', '0004'))!

    expect(after.id).toBe(before.id)
    expect(after.column).toBe(before.column)
    // The app type changed, so the decoded shape differs.
    expect(Schema.decodeUnknownSync(after.schema as any)('42')).toBe(42)
    // The stored type did not, so the drift check sees nothing.
    expect(after.fingerprint).toBe(before.fingerprint)
  })

  it('recodec round-trips back to the stored representation', () => {
    const after = recoded.fieldsById.get(fieldIdOf('notes', '0004'))!
    expect(Schema.encodeUnknownSync(after.schema as any)(42)).toBe('42')
  })

  it('retype assigns a new ID and records the superseded ID', () => {
    const old = fieldIdOf('notes', '0004')
    const fresh = retyped.liveFieldIds.get('notes')!

    expect(fresh).not.toBe(old)
    expect(retyped.retiredFields.has(old)).toBe(true)
    expect(retyped.fieldsById.get(fresh)!.supersedes).toEqual([old])
  })

  it('retype gives the new field its own column, leaving the old one populated', () => {
    expect(retyped.fieldsById.get(fieldIdOf('notes', '0004'))!.column).toBe('notes')
    expect(retyped.fieldsById.get(retyped.liveFieldIds.get('notes')!)!.column).toMatch(
      /^notes_[0-9a-f]{8}$/,
    )
  })

  it('a retype fallback lens is reachable through supersedes', () => {
    const withFallback = schemaIndex
      .appendMigration({
        file: '0005',
        entities: {
          document: migrateSchema(
            doc(5).schema,
            retype('notes', Schema.Number, { decodeFromOld: s => Number(s) }),
          ),
        },
      })
      .byName.get('document')!

    const fresh = withFallback.fieldsById.get(withFallback.liveFieldIds.get('notes')!)!
    expect(withFallback.fieldsById.get(fresh.supersedes![0])!.column).toBe('notes')
    expect(fresh.fallbackDecode!('7')).toBe(7)
  })
})

describe('promote finishes a merge', () => {
  const promoted = schemaIndex
    .appendMigration({
      file: '0005',
      entities: { document: migrateSchema(doc(5).schema, promote('fullName', Schema.String)) },
    })
    .byName.get('document')!

  it('retires the sources it superseded', () => {
    const first = fieldIdOf('firstName', '0000')
    expect(promoted.retiredFields.has(first)).toBe(true)
    expect(promoted.syncedSources.has(first)).toBe(false)
  })

  it('makes the target stored, with its own id and a link to the sources', () => {
    const target = promoted.fieldsById.get(promoted.liveFieldIds.get('fullName')!)!
    expect(target.kind).toBe('stored')
    expect(target.supersedes).toEqual([
      fieldIdOf('firstName', '0000'),
      fieldIdOf('lastName', '0000'),
    ])
  })

  it('refuses to promote a field that is not derived', () => {
    expect(() =>
      schemaIndex.appendMigration({
        file: '0005',
        entities: { document: migrateSchema(doc(5).schema, promote('name', Schema.String)) },
      }),
    ).toThrow(/not a derived field/)
  })
})

describe('merge policies', () => {
  const withPolicies = new SchemaIndex([
    {
      file: '0000',
      entities: {
        document: seed(
          Schema.Struct({
            steps: Schema.Array(Schema.String).annotate({ merge: 'union' }),
            createdAt: Schema.Number.annotate({ merge: 'fww' }),
            title: Schema.String,
          }),
        ),
      },
    },
  ]).byName.get('document')!

  it('records a declared merge policy in the index', () => {
    expect(withPolicies.fieldsById.get(withPolicies.liveFieldIds.get('steps')!)!.policy).toBe(
      'union',
    )
    expect(withPolicies.fieldsById.get(withPolicies.liveFieldIds.get('createdAt')!)!.policy).toBe(
      'fww',
    )
  })

  it('defaults to last-write-wins', () => {
    expect(withPolicies.fieldsById.get(withPolicies.liveFieldIds.get('title')!)!.policy).toBe('lww')
  })

  it('preserves the policy through an optional field wrapper', () => {
    // Optional wrappers must preserve the declared merge policy.
    const born = {
      file: '0000',
      entities: { document: seed(Schema.Struct({ id: Schema.String })) },
    } satisfies Migration

    const added = new SchemaIndex([
      born,
      {
        file: '0001',
        entities: {
          document: migrateSchema(
            shapeOf([born], 'document'),
            addOptional('steps', Schema.Array(Schema.String).annotate({ merge: 'union' })),
          ),
        },
      },
    ]).byName.get('document')!

    expect(added.fieldsById.get(added.liveFieldIds.get('steps')!)!.policy).toBe('union')
  })

  it('folds the policy into the fingerprint, so changing one reads as drift', () => {
    const asLww = new SchemaIndex([
      {
        file: '0000',
        entities: { document: seed(Schema.Struct({ steps: Schema.Array(Schema.String) })) },
      },
    ]).byName.get('document')!

    const union = withPolicies.fieldsById.get(withPolicies.liveFieldIds.get('steps')!)!
    const lww = asLww.fieldsById.get(asLww.liveFieldIds.get('steps')!)!
    expect(union.id).toBe(lww.id)
    expect(union.fingerprint).not.toBe(lww.fingerprint)
  })
})

describe('a unique declaration stays out of what the lockfile records', () => {
  // Unique declarations affect local writes and indexes, not replication fingerprints.
  // Peers with different local uniqueness declarations still converge.
  const withMarker = (declare: <S extends Schema.Top>(schema: S) => Schema.Top) =>
    new SchemaIndex([
      {
        file: '0000',
        entities: {
          bookmarks: seed(
            Schema.Struct({ id: key(1)(Schema.String), host: declare(Schema.String) }),
          ),
        },
      },
    ])

  const plain = withMarker(schema => schema)
  const marked = withMarker(unique(1))

  it('leaves the field fingerprint alone', () => {
    const host = (index: SchemaIndex) => {
      const entity = index.entity('bookmarks')
      return entity.fieldsById.get(entity.liveFieldIds.get('host')!)!
    }
    expect(host(marked).id).toBe(host(plain).id)
    expect(host(marked).fingerprint).toBe(host(plain).fingerprint)
  })

  it('leaves the whole lockfile alone, so declaring it produces no diff to review', () => {
    expect(marked.lockfile()).toBe(plain.lockfile())
  })
})

describe('the lockfile', () => {
  it('is deterministic and records identity, columns, and fingerprints', () => {
    const lock = upto(5).lockfile()
    expect(lock).toContain('entity document')
    expect(lock).toContain('column=title')
    expect(lock).toContain('renamed -> name')
    expect(lock).toContain('retired')
    expect(lock).toContain('synced source')
  })

  it('records a supersession for review', () => {
    const lock = schemaIndex
      .appendMigration({
        file: '0005',
        entities: { document: migrateSchema(doc(5).schema, retype('notes', Schema.Number)) },
      })
      .lockfile()

    expect(lock).toContain('supersedes')
  })
})

describe('the lookups over the ledger', () => {
  // Use the fixture index to exercise the instance exposed to consumers.

  it('has nothing for an id this build never knew', () => {
    // An unknown ID is valid and has no lookup entry.
    expect(
      FIXTURE_INDEX.entity('notes').fieldsById.get(FieldId.make('deadbeefdeadbeef')),
    ).toBeUndefined()
    expect(FIXTURE_INDEX.entities.get(EntityId.make('deadbeefdeadbeef'))).toBeUndefined()
  })

  it('resolves an entity by its current name', () => {
    expect(FIXTURE_INDEX.entity('notes')).toBe(FIXTURE_INDEX.byName.get('notes'))
  })

  it('names the entity a caller asked for when the chain declares none', () => {
    expect(() => FIXTURE_INDEX.entity('ghost')).toThrow("unknown entity 'ghost'")
  })

  it('resolves an entity by its table', () => {
    expect(FIXTURE_INDEX.entityForTable('notes')).toBe(FIXTURE_INDEX.entity('notes'))
  })

  it('names the table a caller asked for when no entity declares it', () => {
    expect(() => FIXTURE_INDEX.entityForTable('ghosts')).toThrow(
      "no entity declares table 'ghosts'",
    )
  })

  it('returns an empty field map for an entity that declares only keys', () => {
    expect(FIXTURE_INDEX.entity('activityGroupLinks').modelFields()).toEqual({})
  })
})
