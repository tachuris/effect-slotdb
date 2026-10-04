import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import { SqlClient, SqlError } from 'effect/sql'
import type { EntityEntry, EntityName } from '../../migration'
import { StorageError, UniqueViolation } from '../../errors'
import { HybridLogicalClock } from '../../changes'
import { decodeRow } from '../types'
import type { RowOf, KeyOf, UniqueOf, WhereOf, InsertOf, PutOf, PatchOf } from '../types'
import { TxImpl, type Tx, type WriteResult } from './tx'
import * as queries from './queries'

export class Db {
  constructor(
    readonly sql: SqlClient.SqlClient,
    readonly onCommit?: (touched: ReadonlyArray<EntityName>) => Effect.Effect<void>,
  ) {}

  /** One row by its key. Excludes tombstoned rows by default. */
  find<E extends EntityEntry<any>>(
    entity: E,
    key: KeyOf<E>,
    options: { readonly includeDeleted?: boolean } = {},
  ): Effect.Effect<RowOf<E> | undefined, StorageError> {
    return queries
      .findRow(this.sql, entity, key, options)
      .pipe(Effect.map(row => (row === undefined ? undefined : decodeRow(entity, row))))
  }

  /**
   * Returns the live row with a unique tuple, or undefined. Selects the lowest row ID
   * when replication produces duplicates so peers with the same rows select the same row.
   */
  findUnique<E extends EntityEntry<any>>(
    entity: E,
    values: UniqueOf<E>,
  ): Effect.Effect<RowOf<E> | undefined, StorageError> {
    return queries
      .findUniqueRow(this.sql, entity, values)
      .pipe(Effect.map(row => (row === undefined ? undefined : decodeRow(entity, row))))
  }

  /** Rows matching equality on named fields. Excludes tombstoned rows by default. */
  all<E extends EntityEntry<any>>(
    entity: E,
    options: {
      readonly where?: WhereOf<E>
      readonly orderBy?: string
      readonly includeDeleted?: boolean
    } = {},
  ): Effect.Effect<ReadonlyArray<RowOf<E>>, StorageError> {
    return queries
      .listRows(this.sql, entity, options)
      .pipe(Effect.map(rows => rows.map(row => decodeRow(entity, row))))
  }

  transaction<A, E = never>(
    body: (tx: Tx) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | StorageError, HybridLogicalClock> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const clock = yield* HybridLogicalClock
      const hlc = yield* clock.now
      const at = DateTime.makeUnsafe(yield* clock.physical)
      const tx = new TxImpl(self.sql, hlc, at)
      const result = yield* self.sql.withTransaction(body(tx))
      if (self.onCommit && tx.touched.size > 0) {
        yield* self.onCommit([...tx.touched])
      }
      return result
    }).pipe(
      // Wrap SQL failures from transaction setup, commit, and rollback.
      // Preserve errors already wrapped by row operations and errors raised by the
      // caller.
      Effect.mapError(cause =>
        cause instanceof SqlError.SqlError
          ? new StorageError({ message: 'Failed to commit a write', cause })
          : (cause as E | StorageError),
      ),
    )
  }

  /** Inserts a row, and stamps it for replication, failing when it already exists. */
  insert<E extends EntityEntry<any>>(
    entity: E,
    row: InsertOf<E>,
  ): Effect.Effect<void, StorageError | UniqueViolation, HybridLogicalClock> {
    return this.transaction(tx => tx.insert(entity, row))
  }

  /**
   * Inserts a row or updates an existing row and stamps changed fields for replication.
   */
  put<E extends EntityEntry<any>>(
    entity: E,
    row: PutOf<E>,
  ): Effect.Effect<void, StorageError | UniqueViolation, HybridLogicalClock> {
    return this.transaction(tx => tx.put(entity, row))
  }

  /**
   * Updates a row by key and stamps changed replicated fields. Returns whether an active
   * row matched.
   */
  update<E extends EntityEntry<any>>(
    entity: E,
    key: KeyOf<E>,
    patch: PatchOf<E>,
  ): Effect.Effect<WriteResult, StorageError | UniqueViolation, HybridLogicalClock> {
    return this.transaction(tx => tx.update(entity, key, patch))
  }

  /**
   * Hides a row with a replicated deletion time. Returns whether an active row matched.
   */
  remove<E extends EntityEntry<any>>(
    entity: E,
    key: KeyOf<E>,
  ): Effect.Effect<WriteResult, StorageError, HybridLogicalClock> {
    return this.transaction(tx => tx.remove(entity, key))
  }
}
