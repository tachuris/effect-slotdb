import type { EntityEntry } from '../migration'
import type {
  IsKeyed,
  IsUnique,
  IsImmutable,
  IsDefaulted,
  IsFramework,
  IsTombstone,
} from '../migration/fields.ts'

/** The decoded value type of a field schema, or `unknown` when not resolvable. */
type TypeOf<F> = F extends { readonly Type: infer T } ? T : unknown

/** The encoded value type of a field schema, or `unknown` when not resolvable. */
type EncodedOf<F> = F extends { readonly Encoded: infer E } ? E : unknown

/**
 * Whether a field is optional on the type side, which makes it omittable on an insert.
 */
type IsOptional<F> = F extends { readonly '~type.optionality': 'optional' } ? true : false

/**
 * Whether a field's decoded type includes null, so the column accepts NULL and the insert
 * can omit it.
 */
type IsNullable<F> = null extends TypeOf<F> ? true : false

/** Extract the field record from an entity's phantom parameter. */
type FieldsOf<E extends EntityEntry<any>> = E extends EntityEntry<infer F> ? F : never

/** The names of row fields, excluding the tombstone. */
type RowFieldNames<F> = {
  [K in keyof F & string]: IsTombstone<F[K]> extends true ? never : K
}[keyof F & string]

/** A live row, decoded, with the tombstone excluded. */
export type RowOf<E extends EntityEntry<any>> = {
  readonly [K in RowFieldNames<FieldsOf<E>>]: TypeOf<FieldsOf<E>[K]>
}

/** A raw row, decoded into the entity's live shape, with the tombstone removed. */
export const decodeRow = <E extends EntityEntry<any>>(
  entity: E,
  row: Record<string, unknown>,
): RowOf<E> => {
  const decoded = entity.decode(row)
  const tombstone = entity.tombstoneField?.currentName
  if (tombstone === undefined) return decoded as RowOf<E>
  const { [tombstone]: _hidden, ...live } = decoded
  return live as RowOf<E>
}

type InsertRequiredNames<F> = {
  [K in keyof F & string]: IsFramework<F[K]> extends true
    ? never
    : IsKeyed<F[K]> extends true
      ? K
      : IsDefaulted<F[K]> extends true
        ? never
        : IsOptional<F[K]> extends true
          ? never
          : IsNullable<F[K]> extends true
            ? never
            : K
}[keyof F & string]

type InsertOptionalNames<F> = {
  [K in keyof F & string]: IsFramework<F[K]> extends true
    ? never
    : IsKeyed<F[K]> extends true
      ? never
      : IsDefaulted<F[K]> extends true
        ? K
        : IsOptional<F[K]> extends true
          ? K
          : IsNullable<F[K]> extends true
            ? K
            : never
}[keyof F & string]

export type InsertOf<E extends EntityEntry<any>> = {
  readonly [K in InsertRequiredNames<FieldsOf<E>>]: TypeOf<FieldsOf<E>[K]>
} & {
  readonly [K in InsertOptionalNames<FieldsOf<E>>]?: TypeOf<FieldsOf<E>[K]>
}

type PatchFieldNames<F> = {
  [K in keyof F & string]: IsFramework<F[K]> extends true
    ? never
    : IsKeyed<F[K]> extends true
      ? never
      : IsImmutable<F[K]> extends true
        ? never
        : K
}[keyof F & string]

export type PatchOf<E extends EntityEntry<any>> = {
  readonly [K in PatchFieldNames<FieldsOf<E>>]?: TypeOf<FieldsOf<E>[K]>
}

type PutFieldNames<F> = {
  [K in keyof F & string]: IsFramework<F[K]> extends true ? never : K
}[keyof F & string]

export type PutOf<E extends EntityEntry<any>> = KeyOf<E> & {
  readonly [K in PutFieldNames<FieldsOf<E>>]?: TypeOf<FieldsOf<E>[K]>
}

type KeyFieldNames<F> = {
  [K in keyof F & string]: IsKeyed<F[K]> extends true ? K : never
}[keyof F & string]

export type KeyOf<E extends EntityEntry<any>> = {
  readonly [K in KeyFieldNames<FieldsOf<E>>]: EncodedOf<FieldsOf<E>[K]>
}

type UniqueFieldNames<F> = {
  [K in keyof F & string]: IsUnique<F[K]> extends true ? K : never
}[keyof F & string]

/**
 * The encoded unique tuple used to select a live row. Entities without unique fields
 * produce an empty record and are rejected by the read operation.
 */
export type UniqueOf<E extends EntityEntry<any>> = {
  readonly [K in UniqueFieldNames<FieldsOf<E>>]: EncodedOf<FieldsOf<E>[K]>
}

export interface Comparison<V = unknown> {
  readonly gt?: V
  readonly gte?: V
  readonly lt?: V
  readonly lte?: V
  readonly in?: ReadonlyArray<V>
}

export type WhereOf<E extends EntityEntry<any>> = {
  readonly [K in RowFieldNames<FieldsOf<E>>]?:
    | EncodedOf<FieldsOf<E>[K]>
    | Comparison<EncodedOf<FieldsOf<E>[K]>>
}
