import { describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import {
  addNullOr,
  addOptional,
  addOptionalWithDefault,
  addRequired,
  canonicalizeAst,
  migrateSchema,
  fieldsOf,
  mapFields,
  mergeFields,
  promote,
  recodec,
  remove,
  rename,
  retype,
  seed,
} from './operations.ts'
import { annotationsOf } from './annotations.ts'
import { FieldId } from './ids.ts'
import { local } from './fields.ts'

const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})

/** An annotated source for operations that require existing field IDs. */
const Stamped = Schema.Struct({
  id: Schema.String.annotate({ fieldId: FieldId.make('0000000000000001') }),
  first: Schema.String.annotate({ fieldId: FieldId.make('0000000000000002') }),
  last: Schema.String.annotate({ fieldId: FieldId.make('0000000000000003') }),
})

const oldRow = { id: 'u1', name: 'Alice' }

const shapeOf = (schema: Schema.Constraint) => canonicalizeAst(schema.ast)
const fieldNames = (schema: Schema.Top) => Object.keys(fieldsOf(schema))

describe('addOptional', () => {
  const UserWithEmail = User.pipe(addOptional('email', Schema.String))

  it('preserves the declared identity on the optional wrapper', () => {
    // Wrapper annotations must preserve the local flag and merge policy.
    const fields = fieldsOf(
      User.pipe(addOptional('tags', Schema.String.annotate({ merge: 'union', local: true }))),
    )
    expect(annotationsOf(fields.tags)).toMatchObject({ merge: 'union', local: true })
  })

  it('decodes an old row that lacks the new field', () => {
    expect(Schema.decodeSync(UserWithEmail)(oldRow)).toEqual({ id: 'u1', name: 'Alice' })
  })

  it('decodes a new row containing the field', () => {
    expect(Schema.decodeSync(UserWithEmail)({ id: 'u2', name: 'Bob', email: 'bob@x' })).toEqual({
      id: 'u2',
      name: 'Bob',
      email: 'bob@x',
    })
  })

  it('keeps a present value on encode', () => {
    // Encoding preserves a present optional field because the schema adds no transform.
    expect(Schema.encodeSync(UserWithEmail)({ id: 'u1', name: 'Alice', email: 'a@x' })).toEqual({
      id: 'u1',
      name: 'Alice',
      email: 'a@x',
    })
  })

  it('omits the field on encode when it is absent', () => {
    expect(Schema.encodeSync(UserWithEmail)({ id: 'u1', name: 'Alice' })).toEqual({
      id: 'u1',
      name: 'Alice',
    })
  })

  it('exposes the new field as optional in the shape', () => {
    expect(shapeOf(UserWithEmail)).toContain('email?')
  })

  it('yields an optional field at the type level', () => {
    type UserWithEmail = typeof UserWithEmail.Type
    const _check: {
      readonly id: string
      readonly name: string
      readonly email?: string | undefined
    } = {} as UserWithEmail
  })

  it('refuses a name the shape already holds', () => {
    // Reject replacement of a live field without an explicit retype.
    // @ts-expect-error
    expect(() => User.pipe(addOptional('name', Schema.String))).toThrow(
      "addOptional: field 'name' already exists",
    )
  })
})

describe('addNullOr', () => {
  const UserWithEmail = User.pipe(addNullOr('email', Schema.String))

  it('preserves the declared identity on the nullable wrapper', () => {
    const fields = fieldsOf(
      User.pipe(addNullOr('tags', Schema.String.annotate({ merge: 'union', local: true }))),
    )
    expect(annotationsOf(fields.tags)).toMatchObject({ merge: 'union', local: true })
  })

  it('decodes a row containing null', () => {
    expect(Schema.decodeUnknownSync(UserWithEmail)({ ...oldRow, email: null })).toEqual({
      id: 'u1',
      name: 'Alice',
      email: null,
    })
  })

  it('decodes a row containing a value', () => {
    expect(Schema.decodeUnknownSync(UserWithEmail)({ ...oldRow, email: 'a@x' })).toEqual({
      id: 'u1',
      name: 'Alice',
      email: 'a@x',
    })
  })

  it('keeps the nullable key required', () => {
    // A nullable field represents absence as null while keeping the key required.
    expect(() => Schema.decodeUnknownSync(UserWithEmail)(oldRow)).toThrow('Missing key')
    expect(shapeOf(UserWithEmail)).not.toContain('email?')
  })

  it('yields a nullable required field at the type level', () => {
    type UserWithEmail = typeof UserWithEmail.Type
    const _check: {
      readonly id: string
      readonly name: string
      readonly email: string | null
    } = {} as UserWithEmail
  })

  it('refuses a name the shape already holds', () => {
    // @ts-expect-error
    expect(() => User.pipe(addNullOr('name', Schema.String))).toThrow(
      "addNullOr: field 'name' already exists",
    )
  })
})

describe('addRequired', () => {
  const UserWithCreatedAt = User.pipe(addRequired('createdAt', Schema.Number, () => 123))

  it('fills the default when decoding an old row', () => {
    expect(Schema.decodeUnknownSync(UserWithCreatedAt)(oldRow)).toEqual({
      id: 'u1',
      name: 'Alice',
      createdAt: 123,
    })
  })

  it('drops the added field when encoding back to the old shape', () => {
    const decoded = Schema.decodeUnknownSync(UserWithCreatedAt)(oldRow)
    expect(Schema.encodeUnknownSync(UserWithCreatedAt)(decoded)).toEqual({
      id: 'u1',
      name: 'Alice',
    })
  })

  it('exposes the new field as required', () => {
    expect(fieldNames(UserWithCreatedAt)).toContain('createdAt')
    expect(shapeOf(UserWithCreatedAt)).not.toContain('createdAt?')
  })

  it('yields a required createdAt at the type level', () => {
    type UserWithCreatedAt = typeof UserWithCreatedAt.Type
    const _check: {
      readonly id: string
      readonly name: string
      readonly createdAt: number
    } = {} as UserWithCreatedAt
  })

  it('refuses a name the shape already holds', () => {
    // @ts-expect-error
    expect(() => User.pipe(addRequired('name', Schema.String, () => ''))).toThrow(
      "addRequired: field 'name' already exists",
    )
  })
})

describe('addOptionalWithDefault', () => {
  const UserWithEmailDefault = User.pipe(
    addOptionalWithDefault('email', Schema.String, () => 'unknown@x'),
  )

  it('fills the default when the key is absent in the old row', () => {
    expect(Schema.decodeUnknownSync(UserWithEmailDefault)(oldRow)).toEqual({
      id: 'u1',
      name: 'Alice',
      email: 'unknown@x',
    })
  })

  it('keeps the present value when the key is provided', () => {
    expect(
      Schema.decodeUnknownSync(UserWithEmailDefault)({ id: 'u3', name: 'Cara', email: 'cara@x' }),
    ).toEqual({ id: 'u3', name: 'Cara', email: 'cara@x' })
  })

  it('re-emits the field on encode, default filled then round-tripped', () => {
    const decoded = Schema.decodeUnknownSync(UserWithEmailDefault)(oldRow)
    expect(Schema.encodeUnknownSync(UserWithEmailDefault)(decoded)).toEqual({
      id: 'u1',
      name: 'Alice',
      email: 'unknown@x',
    })
  })

  it('yields an optional email at the type level', () => {
    type UserWithEmailDefault = typeof UserWithEmailDefault.Type
    const _check: {
      readonly id: string
      readonly name: string
      readonly email?: string
    } = {} as UserWithEmailDefault
  })

  it('refuses a name the shape already holds', () => {
    // @ts-expect-error
    expect(() => User.pipe(addOptionalWithDefault('name', Schema.String, () => ''))).toThrow(
      "addOptionalWithDefault: field 'name' already exists",
    )
  })
})

describe('remove', () => {
  it('strips the field when decoding an old row', () => {
    const UserWithoutName = User.pipe(remove('name'))
    expect(Schema.decodeUnknownSync(UserWithoutName)(oldRow)).toEqual({ id: 'u1' })
  })

  it('fails to encode when no downgrade default is given', () => {
    // The source schema requires the removed field, so encoding without a default fails.
    const UserWithoutName = User.pipe(remove('name'))
    const decoded = Schema.decodeUnknownSync(UserWithoutName)(oldRow)
    expect(() => Schema.encodeUnknownSync(UserWithoutName)(decoded)).toThrow('Missing key')
  })

  it('restores the field with the downgrade default on encode', () => {
    const UserWithoutName = User.pipe(remove('name', { backwardsDefault: '' }))
    const decoded = Schema.decodeUnknownSync(UserWithoutName)(oldRow)
    expect(Schema.encodeUnknownSync(UserWithoutName)(decoded)).toEqual({ id: 'u1', name: '' })
  })

  it('rejects a backwardsDefault whose type does not match the removed field', () => {
    // @ts-expect-error
    User.pipe(remove('name', { backwardsDefault: 0 }))
  })

  it('drops the field from the shape', () => {
    const UserWithoutName = User.pipe(remove('name'))
    expect(fieldNames(UserWithoutName)).toEqual(['id'])
  })

  it('yields a struct without name at the type level', () => {
    const UserWithoutName = User.pipe(remove('name'))
    type UserWithoutName = typeof UserWithoutName.Type
    const _check: { readonly id: string } = {} as UserWithoutName
  })

  it('throws when the source is not a struct or a decodeTo of one', () => {
    expect(() => remove('name')(Schema.String as never)).toThrow(
      'source must be a Struct or a decodeTo target Struct',
    )
  })

  it('names the field it could not find, since dropping nothing would pass silently', () => {
    // @ts-expect-error
    expect(() => User.pipe(remove('missing'))).toThrow("remove: unknown field 'missing'")
  })
})

describe('rename', () => {
  const UserRenamed = User.pipe(rename('name', 'fullName'))

  it('moves the value from the old key to the new key on decode', () => {
    expect(Schema.decodeUnknownSync(UserRenamed)(oldRow)).toEqual({ id: 'u1', fullName: 'Alice' })
  })

  it('moves the value back on encode', () => {
    const decoded = Schema.decodeUnknownSync(UserRenamed)(oldRow)
    expect(Schema.encodeUnknownSync(UserRenamed)(decoded)).toEqual({ id: 'u1', name: 'Alice' })
  })

  it('names the field it could not find, rather than failing deeper down', () => {
    // @ts-expect-error
    expect(() => User.pipe(rename('missing', 'other'))).toThrow("rename: unknown field 'missing'")
  })

  it('yields a struct with the renamed field at the type level', () => {
    type UserRenamed = typeof UserRenamed.Type
    const _check: { readonly id: string; readonly fullName: string } = {} as UserRenamed
  })
})

describe('retype', () => {
  const Retyped = Stamped.pipe(retype('first', Schema.Number))

  it('replaces the stored type of the field', () => {
    expect(Schema.decodeUnknownSync(Retyped)({ id: 'u1', first: 7, last: 'L' })).toEqual({
      id: 'u1',
      first: 7,
      last: 'L',
    })
  })

  it('omits the old ID so derivation assigns a new ID', () => {
    // Omitting the field ID causes derivation to assign a new ID.
    const fields = fieldsOf(Retyped)
    expect(annotationsOf(fields.first).fieldId).toBeUndefined()
    expect(annotationsOf(fields.first).supersedes).toEqual(['0000000000000002'])
  })

  it('records a fallback lens when one is declared', () => {
    const withFallback = Stamped.pipe(
      retype('first', Schema.Number, { decodeFromOld: s => Number(s) }),
    )
    expect(annotationsOf(fieldsOf(withFallback).first).fallbackDecode!('7')).toBe(7)
  })

  it('refuses a field that has no assigned ID', () => {
    expect(() => User.pipe(retype('name', Schema.Number))).toThrow('has no assigned ID')
  })

  it('yields the new field type at the type level', () => {
    type Retyped = typeof Retyped.Type
    const _check: {
      readonly id: string
      readonly first: number
      readonly last: string
    } = {} as Retyped
  })
})

describe('recodec', () => {
  const Recoded = Stamped.pipe(
    recodec('first', Schema.Number, { decode: (s: string) => Number(s), encode: String }),
  )

  it('decodes the stored representation into the new app type', () => {
    expect(Schema.decodeUnknownSync(Recoded)({ id: 'u1', first: '42', last: 'L' })).toEqual({
      id: 'u1',
      first: 42,
      last: 'L',
    })
  })

  it('encodes back to the stored representation', () => {
    expect(Schema.encodeUnknownSync(Recoded)({ id: 'u1', first: 42, last: 'L' })).toEqual({
      id: 'u1',
      first: '42',
      last: 'L',
    })
  })

  it('keeps the id, since the stored bytes never change', () => {
    // Preserve the field ID when the stored representation remains unchanged.
    expect(annotationsOf(fieldsOf(Recoded).first).fieldId).toBe('0000000000000002')
  })

  it('refuses a field that has no assigned ID', () => {
    expect(() =>
      User.pipe(recodec('name', Schema.Number, { decode: Number, encode: String })),
    ).toThrow('has no assigned ID')
  })

  it('yields the new app type over the old stored type at the type level', () => {
    type Recoded = typeof Recoded.Type
    const _check: {
      readonly id: string
      readonly first: number
      readonly last: string
    } = {} as Recoded
    // Recodec preserves the encoded representation.
    const _encoded: { readonly first: string } = {} as typeof Recoded.Encoded
  })
})

describe('mergeFields', () => {
  const split = (v: string): readonly [string, string] => {
    const at = String(v).indexOf(' ')
    return at === -1 ? [v, ''] : [String(v).slice(0, at), String(v).slice(at + 1)]
  }

  const Merged = Stamped.pipe(
    mergeFields(['first', 'last'], 'full', Schema.String, {
      combine: (a, b) => `${a} ${b}`,
      split,
    }),
  )

  it('drops both sources from the shape and adds the target', () => {
    expect(fieldNames(Merged)).toEqual(['id', 'full'])
  })

  it('records the source ids and the projection on the target', () => {
    const target = annotationsOf(fieldsOf(Merged).full)
    expect(target.derivedFrom).toEqual(['0000000000000002', '0000000000000003'])
    expect(target.combine!('Ada', 'Lovelace')).toBe('Ada Lovelace')
    expect(target.split!('Ada Lovelace')).toEqual(['Ada', 'Lovelace'])
  })

  it('marks a target with no split as unwritable', () => {
    const noSplit = Stamped.pipe(
      mergeFields(['first', 'last'], 'full', Schema.String, { combine: (a, b) => `${a} ${b}` }),
    )
    expect(annotationsOf(fieldsOf(noSplit).full).writable).toBe(false)
    expect(annotationsOf(fieldsOf(Merged).full).writable).toBe(true)
  })

  it('refuses a source that has no assigned ID', () => {
    expect(() =>
      User.pipe(mergeFields(['id', 'name'], 'both', Schema.String, { combine: a => a })),
    ).toThrow('has no assigned ID')
  })

  it('yields the target in place of both sources at the type level', () => {
    type Merged = typeof Merged.Type
    const _check: { readonly id: string; readonly full: string } = {} as Merged
  })
})

describe('promote', () => {
  const Merged = Stamped.pipe(
    mergeFields(['first', 'last'], 'full', Schema.String, { combine: (a, b) => `${a} ${b}` }),
  )
  const Promoted = Merged.pipe(promote('full', Schema.String))

  it('records the sources it supersedes and stops deriving', () => {
    const target = annotationsOf(fieldsOf(Promoted).full)
    expect(target.supersedes).toEqual(['0000000000000002', '0000000000000003'])
    expect(target.derivedFrom).toBeUndefined()
  })

  it('omits the old ID so derivation assigns a new ID', () => {
    expect(annotationsOf(fieldsOf(Promoted).full).fieldId).toBeUndefined()
  })

  it('refuses a field that is not derived', () => {
    expect(() => Stamped.pipe(promote('first', Schema.String))).toThrow('not a derived field')
  })

  it('refuses a field the shape does not hold', () => {
    // @ts-expect-error
    expect(() => Stamped.pipe(promote('missing', Schema.String))).toThrow('promote: unknown field')
  })

  it('keeps the shape and states the stored type at the type level', () => {
    type Promoted = typeof Promoted.Type
    const _check: { readonly id: string; readonly full: string } = {} as Promoted
  })
})

describe('mapFields', () => {
  const Localized = mapFields(local)(User)

  it('applies the function to every field', () => {
    expect(annotationsOf(fieldsOf(Localized).id).local).toBe(true)
    expect(annotationsOf(fieldsOf(Localized).name).local).toBe(true)
  })

  it('leaves the shape alone, since an annotation is not part of it', () => {
    expect(shapeOf(Localized)).toBe(shapeOf(User))
  })

  it('yields the same fields at the type level', () => {
    type Localized = typeof Localized.Type
    const _check: { readonly id: string; readonly name: string } = {} as Localized
  })
})

describe('seed', () => {
  const seeded = seed(User)

  it('preserves the supplied schema', () => {
    expect(seeded.schema).toBe(User)
  })

  it('states one operation that ignores its input, so a fold starts from nothing', () => {
    expect(seeded.operations).toHaveLength(1)
    expect(seeded.operations[0]()).toBe(User)
  })

  it('yields the seeded type at the type level', () => {
    type Seeded = typeof seeded.schema.Type
    const _check: { readonly id: string; readonly name: string } = {} as Seeded
  })
})

describe('migrateSchema', () => {
  const migrated = migrateSchema(
    User,
    addOptional('email', Schema.String),
    rename('name', 'fullName'),
  )

  it('applies each operation in order', () => {
    expect(fieldNames(migrated.schema)).toEqual(['id', 'email', 'fullName'])
  })

  it('retains original operations for chain derivation', () => {
    expect(migrated.operations).toHaveLength(2)
    expect(fieldNames(migrated.operations[0](User))).toEqual(['id', 'name', 'email'])
  })

  it('yields the type after the last operation at the type level', () => {
    type Migrated = typeof migrated.schema.Type
    const _check: {
      readonly id: string
      readonly email?: string
      readonly fullName: string
    } = {} as Migrated
  })

  it('applies four operations, the arity a migration adding four fields at once needs', () => {
    const four = migrateSchema(
      User,
      addRequired('a', Schema.String, () => 'a'),
      addRequired('b', Schema.String, () => 'b'),
      addRequired('c', Schema.String, () => 'c'),
      addRequired('d', Schema.String, () => 'd'),
    )
    expect(fieldNames(four.schema)).toEqual(['id', 'name', 'a', 'b', 'c', 'd'])
    expect(four.operations).toHaveLength(4)
  })
})

describe('chaining via pipe', () => {
  it('addOptional then remove', () => {
    const UserChained = User.pipe(addOptional('email', Schema.String), remove('name'))
    expect(Schema.decodeUnknownSync(UserChained)(oldRow)).toEqual({ id: 'u1' })
  })

  it('addRequired then rename', () => {
    const UserChained = User.pipe(
      addRequired('createdAt', Schema.Number, () => 0),
      rename('name', 'fullName'),
    )
    expect(Schema.decodeUnknownSync(UserChained)(oldRow)).toEqual({
      id: 'u1',
      fullName: 'Alice',
      createdAt: 0,
    })
  })

  it('addOptional, addRequired, remove, and rename in one chain', () => {
    const UserChained = User.pipe(
      addOptional('email', Schema.String),
      addRequired('createdAt', Schema.Number, () => 0),
      remove('name'),
      rename('id', 'userId'),
    )
    expect(Schema.decodeUnknownSync(UserChained)(oldRow)).toEqual({
      userId: 'u1',
      createdAt: 0,
    })
  })

  it('encodes addRequired then rename back to the base shape', () => {
    const UserChained = User.pipe(
      addRequired('createdAt', Schema.Number, () => 0),
      rename('name', 'fullName'),
    )
    const decoded = Schema.decodeUnknownSync(UserChained)(oldRow)
    // Encode through the chain by renaming fullName to name and removing createdAt.
    expect(Schema.encodeUnknownSync(UserChained)(decoded)).toEqual({ id: 'u1', name: 'Alice' })
  })

  it('fails to encode a chain whose remove has no downgrade default', () => {
    const UserChained = User.pipe(addOptional('email', Schema.String), remove('name'))
    const decoded = Schema.decodeUnknownSync(UserChained)(oldRow)
    expect(() => Schema.encodeUnknownSync(UserChained)(decoded)).toThrow('Missing key')
  })
})

describe('canonicalizeAst', () => {
  it('ignores field order', () => {
    const a = Schema.Struct({ x: Schema.String, y: Schema.Number })
    const b = Schema.Struct({ y: Schema.Number, x: Schema.String })
    expect(canonicalizeAst(a.ast)).toBe(canonicalizeAst(b.ast))
  })

  it('excludes annotations from shape fingerprints', () => {
    const plain = Schema.Struct({ a: Schema.String })
    const annotated = Schema.Struct({
      a: Schema.String.annotate({ fieldId: FieldId.make('0000000000000009') }),
    })
    expect(canonicalizeAst(plain.ast)).toBe(canonicalizeAst(annotated.ast))
  })

  it('distinguishes optionality', () => {
    const required = Schema.Struct({ a: Schema.String })
    const optional = Schema.Struct({ a: Schema.optional(Schema.String) })
    expect(canonicalizeAst(required.ast)).not.toBe(canonicalizeAst(optional.ast))
  })

  it('renders literal values', () => {
    expect(canonicalizeAst(Schema.Literals(['Skipped', 'Done']).ast)).toBe('("Done"|"Skipped")')
    expect(canonicalizeAst(Schema.Literals([0, 1]).ast)).toBe('(0|1)')
    expect(canonicalizeAst(Schema.Literal(true).ast)).toBe('true')
    expect(canonicalizeAst(Schema.Literal(1n).ast)).toBe('1n')
  })

  it('distinguishes a renamed literal', () => {
    const before = Schema.Literals(['Skipped', 'Done'])
    const after = Schema.Literals(['Snoozed', 'Done'])
    expect(canonicalizeAst(before.ast)).not.toBe(canonicalizeAst(after.ast))
  })

  it('distinguishes a string literal from a number literal of the same digits', () => {
    expect(canonicalizeAst(Schema.Literal('1').ast)).not.toBe(
      canonicalizeAst(Schema.Literal(1).ast),
    )
  })
})
