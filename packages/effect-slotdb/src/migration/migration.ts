import * as Schema from 'effect/Schema'

type AnySchema = Schema.Top

/** One curried migration step, as produced by the operation vocabulary. */
export type MigrationOp = (schema: any) => AnySchema

export const EntityName = Schema.String
export type EntityName = typeof EntityName.Type

export interface Migration {
  /**
   * The migration's position and stable identity in the chain. Changing `file` changes
   * IDs of fields declared in the migration. Use a short identifier independent of the
   * label.
   */
  readonly file: string
  /**
   * A migration label that defaults to `file`. Does not affect field IDs. Preserve the
   * label after application because migration history uses the label to detect conflicts.
   */
  readonly name?: string
  /**
   * Operations and resulting schemas by current entity name. `seed` and `migrateSchema` produce
   * both.
   */
  readonly entities?: Readonly<
    Record<EntityName, { schema: AnySchema; operations: ReadonlyArray<MigrationOp> }>
  >
  /**
   * Entity renames applied before the migration's operations. Preserve target names as
   * literal types. Use `as const` when `satisfies Migration` widens a target to `string`.
   */
  readonly renameEntity?: Readonly<Record<EntityName, EntityName>>
  /**
   * Custom statements executed after the migration's derived DDL. Use for seeding and
   * backfills that require application logic.
   */
  readonly sql?: ReadonlyArray<string>
}

/**
 * Checks for unknown migration properties without widening literal types. Intersect with
 * the migration type to preserve entity and rename target names.
 */
export type NoExtraProperties<M> = {
  readonly [K in Exclude<keyof M, keyof Migration>]: {
    error: `'${K & string}' is not a property of a migration`
  }
}
