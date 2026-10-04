import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import * as SchemaTransformation from 'effect/SchemaTransformation'
import type { Assign, Simplify } from 'effect/Struct'
import { annotationsOf } from './annotations.ts'
import { type FieldId } from './ids.ts'
import {
  withDefault,
  type IsKeyed,
  type IsImmutable,
  type IsDefaulted,
  type IsLocal,
  type IsFramework,
  type IsTombstone,
  type Keyed,
  type Immutable,
  type Defaulted,
  type Local,
  type Framework,
  type Tombstone,
} from './fields.ts'

type AnyFields = Schema.Struct.Fields
type AnySchema = Schema.Top

type FieldEntry<K extends string, S extends Schema.Constraint> = { readonly [P in K]: S }

/**
 * Preserves field markers from `Sc` on a wrapper result `W`. Schema wrappers otherwise
 * omit the marker intersections from their types.
 */
type CarryMarkers<Sc, W> = W &
  (IsKeyed<Sc> extends true ? Keyed<W> : unknown) &
  (IsImmutable<Sc> extends true ? Immutable<W> : unknown) &
  (IsDefaulted<Sc> extends true ? Defaulted<W> : unknown) &
  (IsLocal<Sc> extends true ? Local<W> : unknown) &
  (IsFramework<Sc> extends true ? Framework<W> : unknown) &
  (IsTombstone<Sc> extends true ? Tombstone<W> : unknown)

/**
 * The concrete fields of a schema that may be a bare `Struct` or a `decodeTo` wrapping
 * one.
 */
export const fieldsOf = (source: AnySchema): AnyFields => {
  const s = source as any
  if (s.fields) return s.fields as AnyFields
  if (s.to?.fields) return s.to.fields as AnyFields
  throw new Error('migration: source has no fields (not a Struct or decodeTo of a Struct)')
}

const dropField = (fields: AnyFields, field: string): AnyFields => {
  const { [field]: _drop, ...rest } = fields
  return rest as AnyFields
}

const structFromFields = <F extends AnyFields>(fields: F): Schema.Struct<Simplify<F>> =>
  Schema.Struct(fields as Parameters<typeof Schema.Struct>[0]) as Schema.Struct<Simplify<F>>

const structFrom = (fields: AnyFields): AnySchema => structFromFields(fields) as AnySchema

const requireId = (fields: AnyFields, field: string, op: string): FieldId => {
  const schema = fields[field]
  if (schema === undefined) throw new Error(`${op}: unknown field '${field}'`)
  const id = annotationsOf(schema).fieldId
  if (id === undefined) throw new Error(`${op}: field '${field}' has no id yet`)
  return id
}

/** Extracts the field types from a struct or a `decodeTo` target struct. */
export type StructFieldsOf<S> = S extends { readonly fields: AnyFields }
  ? S['fields']
  : S extends { readonly to: { readonly fields: AnyFields } }
    ? S['to']['fields']
    : never

/** The schema for field `F` in source `S`. */
type FieldAt<S, F extends string> = StructFieldsOf<S>[F] extends Schema.Constraint
  ? StructFieldsOf<S>[F]
  : Schema.Constraint

/** The encoded type of field `F` in source `S`, or `unknown` if unresolved. */
type FieldEncoded<S, F extends string> = StructFieldsOf<S>[F] extends { readonly Encoded: infer E }
  ? E
  : unknown

/** The field names declared by `S`. */
type FieldNames<S> = keyof StructFieldsOf<S> & string

/** Whether the fields of `S` are known. A source typed only as a schema answers no. */
type ShapeKnown<S> = [StructFieldsOf<S>] extends [never] ? false : true

/**
 * Whether `S` includes all names in `F`. Accepts unknown shapes. Error objects use
 * literal messages so TypeScript displays the rejected field names.
 */
type HasField<S, F extends string> =
  ShapeKnown<S> extends false ? true : [F] extends [keyof StructFieldsOf<S>] ? true : false

/**
 * Requires all named fields at the call site. Rejects unknown names before chain derivation.
 */
type WithField<S, F extends string> =
  HasField<S, F> extends true
    ? S
    : {
        error: `unknown field '${Exclude<F, FieldNames<S>>}'`
        validFields: keyof StructFieldsOf<S> & string
      }

/**
 * Rejects names already in the source. Replacing a stored type requires an explicit
 * `retype` operation.
 */
type WithoutField<S, F extends string> =
  ShapeKnown<S> extends false
    ? S
    : [F] extends [keyof StructFieldsOf<S>]
      ? { error: `field '${F}' already exists. Use retype or recodec to change its type` }
      : S

/**
 * Requires the removed field to exist and any backward default to match its encoded type.
 */
type RemoveSelf<S, F extends string, V> =
  HasField<S, F> extends false
    ? {
        error: `unknown field '${Exclude<F, FieldNames<S>>}'`
        validFields: keyof StructFieldsOf<S> & string
      }
    : [V] extends [never]
      ? S
      : [V] extends [FieldEncoded<S, F>]
        ? S
        : {
            error: `backwardsDefault does not match the encoded type of '${F}'`
            expected: FieldEncoded<S, F>
          }

// --- altering fields ------------------------------------------------------

/** Applies `fn`, such as `local` or `latch`, to every field of a struct. */
export const mapFields =
  (fn: <S extends Schema.Top>(schema: S) => S['Rebuild']) =>
  <F extends AnyFields>(source: Schema.Struct<F>): Schema.Struct<Simplify<F>> =>
    structFromFields(
      Object.fromEntries(
        Object.entries(source.fields).map(([name, schema]) => [name, fn(schema as any)]),
      ) as F,
    )

/** Initializes a schema with one seed operation for an entity's first migration. */
export function seed<const Fields extends Schema.Struct.Fields, S extends Schema.Struct<Fields>>(
  schema: S,
) {
  return { schema, operations: [() => schema] }
}

/**
 * Applies operations to `seed` and returns the resulting schema with the original
 * operations.
 */
export function migrateSchema<S, B>(
  seed: S,
  ab: (a: S) => B,
): { readonly schema: B; readonly operations: readonly [(a: S) => B] }
export function migrateSchema<S, B, C>(
  seed: S,
  ab: (a: S) => B,
  bc: (b: B) => C,
): { readonly schema: C; readonly operations: readonly [(a: S) => B, (b: B) => C] }
export function migrateSchema<S, B, C, D>(
  seed: S,
  ab: (a: S) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
): { readonly schema: D; readonly operations: readonly [(a: S) => B, (b: B) => C, (c: C) => D] }
export function migrateSchema<S, B, C, D, E>(
  seed: S,
  ab: (a: S) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
): {
  readonly schema: E
  readonly operations: readonly [(a: S) => B, (b: B) => C, (c: C) => D, (d: D) => E]
}
// Add overloads when migrations require more operations.
export function migrateSchema(seed: any, ...operations: any[]): any {
  return { schema: operations.reduce((acc, op) => op(acc), seed), operations }
}

// Use `Migration.renameEntity` because entity renames change entity names, not field schemas.

// --- adding fields ---------------------------------------------------------

/** Rejects a field name already declared by the source. */
const requireAbsent = (fields: AnyFields, field: string, op: string): void => {
  if (fields[field] !== undefined) throw new Error(`${op}: field '${field}' already exists`)
}

/** Adds a required field. Fills `def()` for old rows that lack the field. */
export function addRequired<const F extends string, Sc extends Schema.Constraint>(
  field: F,
  schema: Sc,
  def: () => Sc['Encoded'],
): <S extends Schema.Constraint>(
  self: WithoutField<S, F>,
) => Schema.decodeTo<
  Schema.Struct<
    Simplify<Assign<StructFieldsOf<S>, FieldEntry<F, CarryMarkers<Sc, Defaulted<Sc>>>>>
  >,
  S
>
export function addRequired(field: string, schema: Schema.Constraint, def: () => unknown): any {
  return (source: AnySchema) => {
    const fields = fieldsOf(source)
    requireAbsent(fields, field, 'addRequired')
    const targetStruct = structFromFields({
      ...fields,
      [field]: withDefault(def())(schema as any),
    })
    return source.pipe(
      Schema.decodeTo(
        targetStruct as Parameters<typeof Schema.decodeTo>[0],
        SchemaTransformation.transform({
          decode: (row: any) => ({ ...row, [field]: def() }),
          encode: (row: any) => dropField(row, field),
        }) as any,
      ),
    ) as any
  }
}

/** Adds a nullable field. */
export function addNullOr<const F extends string, Sc extends Schema.Constraint>(
  field: F,
  schema: Sc,
): <S extends Schema.Constraint>(
  self: WithoutField<S, F>,
) => Schema.Struct<
  Simplify<Assign<StructFieldsOf<S>, FieldEntry<F, CarryMarkers<Sc, Schema.NullOr<Sc>>>>>
>
export function addNullOr(field: string, schema: Schema.Constraint): any {
  return (source: AnySchema) => {
    const fields = fieldsOf(source)
    requireAbsent(fields, field, 'addNullOr')
    const nullable = Schema.NullOr(schema as any).annotate(annotationsOf(schema as AnySchema))
    return structFrom({ ...fields, [field]: nullable })
  }
}

/** Adds an optional field that permits old rows without the field to decode. */
export function addOptional<const F extends string, Sc extends Schema.Constraint>(
  field: F,
  schema: Sc,
): <S extends Schema.Constraint>(
  self: WithoutField<S, F>,
) => Schema.Struct<
  Simplify<Assign<StructFieldsOf<S>, FieldEntry<F, CarryMarkers<Sc, Schema.optional<Sc>>>>>
>
export function addOptional(field: string, schema: Schema.Constraint): any {
  return (source: AnySchema) => {
    const fields = fieldsOf(source)
    requireAbsent(fields, field, 'addOptional')
    const optional = Schema.optional(schema as any).annotate(annotationsOf(schema as AnySchema))
    return structFrom({ ...fields, [field]: optional })
  }
}

/**
 * Adds an optional field that decodes a missing key to `def()` and preserves present
 * values.
 */
export function addOptionalWithDefault<const F extends string, Sc extends Schema.Constraint>(
  field: F,
  schema: Sc,
  def: () => Sc['Encoded'],
): <S extends Schema.Constraint>(
  self: WithoutField<S, F>,
) => Schema.Struct<Simplify<Assign<StructFieldsOf<S>, FieldEntry<F, Schema.optionalKey<Sc>>>>>
export function addOptionalWithDefault(
  field: string,
  schema: Schema.Constraint,
  def: () => unknown,
): any {
  return (source: AnySchema) => {
    const fields = fieldsOf(source)
    requireAbsent(fields, field, 'addOptionalWithDefault')
    const fieldWithDefault = Schema.optionalKey(schema).pipe(
      Schema.decodeTo(
        schema as Parameters<typeof Schema.decodeTo>[0],
        SchemaTransformation.transformOptional({
          decode: (maybeValue: Option.Option<unknown>) =>
            Option.some(Option.isSome(maybeValue) ? maybeValue.value : def()),
          encode: (maybeValue: Option.Option<unknown>) => maybeValue,
        }) as any,
      ),
    )
    return structFromFields({ ...fields, [field]: fieldWithDefault }) as any
  }
}

// --- removing and renaming -------------------------------------------------

/**
 * Removes a field from the current schema while retaining its stored column and retired
 * ID. `backwardsDefault` applies only when encoding to the source schema.
 */
export function remove<const F extends string, V = never>(
  field: F,
  options?: { backwardsDefault?: V },
): <S extends Schema.Constraint>(
  self: RemoveSelf<S, F, V>,
) => Schema.decodeTo<Schema.Struct<Simplify<Omit<StructFieldsOf<S>, F>>>, S>
export function remove<F extends string>(field: F, options?: { backwardsDefault?: unknown }): any {
  return (source: AnySchema) => {
    const fields = fieldsOf(source)
    if (fields[field] === undefined) throw new Error(`remove: unknown field '${field}'`)
    const targetStruct = structFromFields(dropField(fields, field))
    const defaultValue = options?.backwardsDefault
    return source.pipe(
      Schema.decodeTo(
        targetStruct as Parameters<typeof Schema.decodeTo>[0],
        SchemaTransformation.transform({
          decode: (row: any) => dropField(row, field),
          encode: (row: any) =>
            defaultValue !== undefined ? { ...row, [field]: defaultValue } : dropField(row, field),
        }) as any,
      ),
    ) as any
  }
}

/** Renames a field while preserving its schema, ID, and stored column. */
export function rename<const From extends string, const To extends string>(
  from: From,
  to: To,
): <S extends Schema.Constraint>(
  self: WithField<S, From>,
) => Schema.decodeTo<
  Schema.Struct<
    Simplify<Assign<Omit<StructFieldsOf<S>, From>, FieldEntry<To, StructFieldsOf<S>[From]>>>
  >,
  S
>
export function rename<From extends string, To extends string>(from: From, to: To): any {
  return (source: AnySchema) => {
    const sourceFields = fieldsOf(source)
    const { [from]: fieldSchema, ...rest } = sourceFields
    if (fieldSchema === undefined) throw new Error(`rename: unknown field '${from}'`)
    const targetStruct = structFromFields({ ...rest, [to]: fieldSchema } as AnyFields)
    return source.pipe(
      Schema.decodeTo(
        targetStruct as Parameters<typeof Schema.decodeTo>[0],
        SchemaTransformation.transform({
          decode: (row: any) => {
            const { [from]: _drop, ...r } = row
            return { ...r, [to]: row[from] }
          },
          encode: (row: any) => {
            const { [to]: _drop, ...r } = row
            return { ...r, [from]: row[to] }
          },
        }) as any,
      ),
    ) as any
  }
}

// --- changing a field's type -----------------------------------------------

/**
 * Changes the application type while preserving the stored type, ID, and column. Copies
 * identity to the target schema so derivation retains the field ID.
 */
export function recodec<const F extends string, A extends Schema.Constraint>(
  field: F,
  target: A,
  codec: { readonly decode: (encoded: any) => any; readonly encode: (value: any) => any },
): <S extends Schema.Constraint>(
  self: WithField<S, F>,
) => Schema.Struct<
  Simplify<Assign<StructFieldsOf<S>, FieldEntry<F, Schema.decodeTo<A, FieldAt<S, F>>>>>
>
export function recodec(
  field: string,
  target: Schema.Constraint,
  codec: { readonly decode: (encoded: any) => any; readonly encode: (value: any) => any },
): any {
  return (source: AnySchema) => {
    const fields = fieldsOf(source)
    const current = fields[field]
    if (current === undefined) throw new Error(`recodec: unknown field '${field}'`)
    const id = requireId(fields, field, 'recodec')

    const annotated = (target as any).annotate({ ...annotationsOf(current), fieldId: id })
    const recoded = (current as any).pipe(
      Schema.decodeTo(annotated, SchemaTransformation.transform(codec) as any),
    )

    return structFrom({ ...fields, [field]: recoded })
  }
}

/**
 * Changes the stored type with a new ID and column while retaining the retired slot.
 * `decodeFromOld` reads the retired value when the new slot is empty. The callback
 * prevents serialization of the operation.
 */
export function retype<const F extends string, A extends Schema.Constraint>(
  field: F,
  target: A,
  options?: { readonly decodeFromOld?: (old: unknown) => unknown },
): <S extends Schema.Constraint>(
  self: WithField<S, F>,
) => Schema.Struct<Simplify<Assign<StructFieldsOf<S>, FieldEntry<F, A>>>>
export function retype(
  field: string,
  target: Schema.Constraint,
  options?: { readonly decodeFromOld?: (old: unknown) => unknown },
): any {
  return (source: AnySchema) => {
    const fields = fieldsOf(source)
    const old = requireId(fields, field, 'retype')

    // Omit fieldId so derivation assigns a new identity.
    const replaced = (target as any).annotate({
      supersedes: [old],
      fallbackDecode: options?.decodeFromOld,
    })

    return structFrom({ ...fields, [field]: replaced })
  }
}

// --- merging and finishing a merge -----------------------------------------

/**
 * Combines two replicated source fields into a derived field. `combine` computes reads
 * and `split` maps edits back to the source slots. Without `split`, the derived field is
 * read only.
 */
export function mergeFields<
  const Sources extends readonly [string, string],
  const T extends string,
  A extends Schema.Constraint,
>(
  sources: Sources,
  target: T,
  targetSchema: A,
  transform: {
    readonly combine: (a: any, b: any) => any
    readonly split?: (value: any) => readonly [any, any]
  },
): <S extends Schema.Constraint>(
  self: WithField<S, Sources[number]>,
) => Schema.Struct<Simplify<Assign<Omit<StructFieldsOf<S>, Sources[number]>, FieldEntry<T, A>>>>
export function mergeFields(
  sources: readonly [string, string],
  target: string,
  targetSchema: Schema.Constraint,
  transform: {
    readonly combine: (a: any, b: any) => any
    readonly split?: (value: any) => readonly [any, any]
  },
): any {
  return (source: AnySchema) => {
    const fields = fieldsOf(source)
    const ids = [
      requireId(fields, sources[0], 'mergeFields'),
      requireId(fields, sources[1], 'mergeFields'),
    ] as const

    const linked = (targetSchema as any).annotate({
      derivedFrom: ids,
      combine: transform.combine,
      split: transform.split,
      writable: typeof transform.split === 'function',
    })

    const { [sources[0]]: _a, [sources[1]]: _b, ...rest } = fields
    return structFrom({ ...rest, [target]: linked })
  }
}

/**
 * Stores a derived field under a new ID and retires its source slots. Apply after every
 * peer understands the target so writes to the old sources are not lost.
 */
export function promote<const F extends string, A extends Schema.Constraint>(
  field: F,
  target: A,
): <S extends Schema.Constraint>(
  self: WithField<S, F>,
) => Schema.Struct<Simplify<Assign<StructFieldsOf<S>, FieldEntry<F, A>>>>
export function promote(field: string, target: Schema.Constraint): any {
  return (source: AnySchema) => {
    const fields = fieldsOf(source)
    const current = fields[field]
    if (current === undefined) throw new Error(`promote: unknown field '${field}'`)

    const sources = annotationsOf(current).derivedFrom
    if (sources === undefined) throw new Error(`promote: '${field}' is not a derived field`)

    // Omit derivedFrom so the target becomes stored under a new ID.
    return structFrom({ ...fields, [field]: (target as any).annotate({ supersedes: sources }) })
  }
}

// --- shape fingerprinting --------------------------------------------------

/** Returns a type fingerprint independent of field order and annotations. */
export const canonicalizeAst = (ast: any): string => {
  if (SchemaAST.isObjects(ast)) {
    const props = ast.propertySignatures
      .map((ps: any) => {
        const optional = SchemaAST.isOptional(ps.type) ? '?' : ''
        return `${String(ps.name)}${optional}:${canonicalizeAst(ps.type)}`
      })
      .sort()
    return `{${props.join(',')}}`
  }
  if (Array.isArray(ast.types)) {
    return `(${ast.types.map(canonicalizeAst).sort().join('|')})`
  }
  return String(ast._tag)
}
