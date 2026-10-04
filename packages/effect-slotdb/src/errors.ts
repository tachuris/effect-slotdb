import * as Effect from 'effect/Effect'
import * as Data from 'effect/Data'

/**
 * A failed storage operation with a message and cause. Consumers map the error to their
 * application error types.
 */
export class StorageError extends Data.TaggedError('StorageError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** A local write rejected because another live row has the same unique tuple. */
export class UniqueViolation extends Data.TaggedError('UniqueViolation')<{
  readonly entity: string
  /** The colliding values, keyed the way a write names them. */
  readonly values: Record<string, unknown>
}> {
  get message(): string {
    const values = Object.entries(this.values)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join(', ')
    return `A live row of '${this.entity}' already holds ${values} on this peer.`
  }
}

/**
 * Excludes {@link UniqueViolation} from writes to entities without unique fields. Treats
 * an unexpected violation as a defect.
 */
export const dieOnDuplicate = <A, E, R>(
  effect: Effect.Effect<A, E | UniqueViolation, R>,
): Effect.Effect<A, Exclude<E, UniqueViolation>, R> =>
  Effect.catchTag(effect, 'UniqueViolation', Effect.die) as Effect.Effect<
    A,
    Exclude<E, UniqueViolation>,
    R
  >

export const mapStorageErrorMessage =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, StorageError, R> =>
    Effect.mapError(effect, cause =>
      cause instanceof StorageError ? cause : new StorageError({ message, cause }),
    )
