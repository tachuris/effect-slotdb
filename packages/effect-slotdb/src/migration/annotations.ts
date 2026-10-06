import * as Schema from 'effect/Schema'
import { FieldId } from './ids'

/**
 * Policies for merging concurrent slot writes.
 * Policies are commutative, associative, and idempotent.
 */
export const MergePolicy = Schema.Literals(['lww', 'fww', 'max', 'min', 'or', 'and', 'union'])
export type MergePolicy = typeof MergePolicy.Type

/**
 * The purpose of a framework field. `tombstone` controls row visibility. `created`
 * records creation time.
 */
export const FrameworkRole = Schema.Literals(['tombstone', 'created'])
export type FrameworkRole = typeof FrameworkRole.Type

/**
 * Field identity and storage metadata on value schemas.
 * Extends Effect's `Annotations` namespace through module augmentation.
 */
declare module 'effect/Schema' {
  namespace Annotations {
    interface Annotations {
      /** The field ID assigned by schema derivation. */
      readonly fieldId?: FieldId

      /** The source field IDs used to compute a merge target. */
      readonly derivedFrom?: readonly FieldId[]

      /** The field IDs replaced by a retype or promote result. */
      readonly supersedes?: readonly FieldId[]

      /** Decodes a superseded slot when the current slot is empty. */
      readonly fallbackDecode?: (old: unknown) => unknown

      /** Maps the current slot's value to the superseded slot's type on each write. */
      readonly fallbackEncode?: (value: unknown) => unknown

      readonly combine?: (a: any, b: any) => any

      readonly split?: (value: any) => readonly [any, any]

      /**
       * False for a merge target without `split` because the target cannot accept writes.
       */
      readonly writable?: boolean

      readonly merge?: MergePolicy

      /**
       * The field's position in the immutable natural key, starting at one. Determines
       * row identity and the unique key index.
       */
      readonly key?: number

      /**
       * The field's position in the unique tuple, starting at one. Local writes enforce
       * uniqueness among live rows. Replication permits duplicates and reads select one
       * row deterministically.
       */
      readonly unique?: number

      /** Whether the field is stored locally without replication or stamps. */
      readonly local?: boolean

      readonly column?: string

      /**
       * The encoded column default for writes that omit the field. Applies only to
       * storage and does not affect the replication fingerprint.
       */
      readonly columnDefault?: unknown

      /** Whether a derived field has a stored column for queries. */
      readonly materialize?: boolean

      /**
       * The framework's field role, absent for fields written by the application.
       * Framework fields are excluded from write types.
       * Tombstones are also excluded from row types.
       */
      readonly framework?: FrameworkRole
    }
  }
}

/**
 * Reads field annotations, including annotations on a `decodeTo` target.
 * Target annotations preserve identity through `recodec`.
 */
export const annotationsOf = (schema: Schema.Constraint): Schema.Annotations.Annotations =>
  (Schema.resolveAnnotations(schema) ?? {}) as Schema.Annotations.Annotations
