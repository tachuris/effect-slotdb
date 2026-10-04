import * as Schema from 'effect/Schema'

/**
 * Declares field identity, storage, and merge behavior. Fields default to last write
 * wins. Changing a stored type or merge policy requires `retype`.
 */

// Phantom markers preserve field distinctions that annotations omit from schema types.
// Each helper sets the marker and annotation together.
// Type tests compare the declared markers with the runtime index.

export declare const KeyMark: unique symbol
export declare const UniqueMark: unique symbol
export declare const ImmutableMark: unique symbol
export declare const DefaultedMark: unique symbol
export declare const LocalMark: unique symbol
export declare const FrameworkMark: unique symbol
export declare const TombstoneMark: unique symbol

// Named interfaces let declaration output reference brands with computed keys.

/** The natural key brand attached by `key`. */
export interface WithKeyMark {
  readonly [KeyMark]: true
}

/** The unique tuple brand attached by `unique`. */
export interface WithUniqueMark {
  readonly [UniqueMark]: true
}

/** The immutability brand attached by `immutable`. */
export interface WithImmutableMark {
  readonly [ImmutableMark]: true
}

/** The default value brand attached by `withDefault`. */
export interface WithDefaultedMark {
  readonly [DefaultedMark]: true
}

/** The local field brand attached by `local`. */
export interface WithLocalMark {
  readonly [LocalMark]: true
}

/** The brand that identifies a field written by the framework. */
export interface WithFrameworkMark {
  readonly [FrameworkMark]: true
}

/** The brand that identifies the tombstone field. */
export interface WithTombstoneMark {
  readonly [TombstoneMark]: true
}

/** A field that forms part of the row's natural key. */
export type Keyed<S> = S & WithKeyMark

/** A field that forms part of the tuple no two live rows on this peer may share. */
export type Unique<S> = S & WithUniqueMark

/** A field set at row creation and excluded from updates. */
export type Immutable<S> = S & WithImmutableMark

/** A field that takes a default when a write does not name it. */
export type Defaulted<S> = S & WithDefaultedMark

/** A field that is stored and never replicated. */
export type Local<S> = S & WithLocalMark

/** A readable framework field excluded from application writes. */
export type Framework<S> = S & WithFrameworkMark

/** A framework field that controls row visibility and is excluded from row types. */
export type Tombstone<S> = S & WithTombstoneMark

/** Whether `S` has the key marker. */
export type IsKeyed<S> = S extends WithKeyMark ? true : false

/** Whether `S` has the unique marker. */
export type IsUnique<S> = S extends WithUniqueMark ? true : false

/** Whether `S` has the immutability marker. */
export type IsImmutable<S> = S extends WithImmutableMark ? true : false

/** Whether `S` has the defaulted marker. */
export type IsDefaulted<S> = S extends WithDefaultedMark ? true : false

/** Whether `S` has the local marker. */
export type IsLocal<S> = S extends WithLocalMark ? true : false

/** Whether `S` has the framework marker. */
export type IsFramework<S> = S extends WithFrameworkMark ? true : false

/** Whether `S` has the tombstone marker. */
export type IsTombstone<S> = S extends WithTombstoneMark ? true : false

/**
 * Declares a field set at row creation with first write wins. Use `key` for fields that
 * determine row identity.
 */
export const immutable = <S extends Schema.Top>(schema: S): Immutable<S['Rebuild']> =>
  schema.annotate({ merge: 'fww' }) as Immutable<S['Rebuild']>

/**
 * Declares an immutable natural key field at a position starting at one. Key fields
 * determine row identity and the unique key index.
 */
export const key =
  (position: number) =>
  <S extends Schema.Top>(schema: S): Keyed<S['Rebuild']> & Immutable<S['Rebuild']> =>
    schema.annotate({ merge: 'fww', key: position }) as Keyed<S['Rebuild']> &
      Immutable<S['Rebuild']>

/**
 * Declares a mutable unique tuple field at a position starting at one. Local writes
 * enforce uniqueness among live rows. Tombstones release tuple values for reuse.
 */
export const unique =
  (position: number) =>
  <S extends Schema.Top>(schema: S): Unique<S['Rebuild']> =>
    schema.annotate({ unique: position }) as Unique<S['Rebuild']>

/** Declares a set stored as a JSON list and merged by union. */
export const growOnly = <S extends Schema.Top>(schema: S) => schema.annotate({ merge: 'union' })

/** Declares a value merged by maximum value rather than stamp order. */
export const highWater = <S extends Schema.Top>(schema: S) => schema.annotate({ merge: 'max' })

/** Declares a boolean merged by disjunction. A true value remains true after merging. */
export const latch = <S extends Schema.Top>(schema: S) => schema.annotate({ merge: 'or' })

/** Declares a stored field excluded from replication and stamping. */
export const local = <S extends Schema.Top>(schema: S): Local<S['Rebuild']> =>
  schema.annotate({ local: true }) as Local<S['Rebuild']>

/**
 * Declares an encoded column default for writes that omit the field. The default applies
 * only to storage and does not replicate.
 */
export const withDefault =
  (value: unknown) =>
  <S extends Schema.Top>(schema: S): Defaulted<S['Rebuild']> =>
    schema.annotate({ columnDefault: value }) as Defaulted<S['Rebuild']>

/**
 * Declares a replicated deletion time that hides rows while preserving their slots.
 * Merges by earliest deletion time.
 */
export const deletedAt = {
  deletedAt: Schema.NullOr(Schema.DateTimeUtcFromString).annotate({
    framework: 'tombstone',
    merge: 'min',
  }) as Tombstone<Schema.NullOr<typeof Schema.DateTimeUtcFromString>> &
    Framework<Schema.NullOr<typeof Schema.DateTimeUtcFromString>>,
}

/**
 * The epoch column default for {@link createdAt}.
 * @internal
 */
export const EPOCH = '1970-01-01T00:00:00.000Z'

/**
 * Declares a creation time written by the framework on insertion and merged by minimum
 * value. An unstamped epoch default permits partially replicated rows to be inserted.
 */
export const createdAt = {
  createdAt: Schema.DateTimeUtcFromString.annotate({
    framework: 'created',
    columnDefault: EPOCH,
    merge: 'min',
  }) as Framework<typeof Schema.DateTimeUtcFromString>,
}
