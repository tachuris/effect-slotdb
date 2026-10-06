import type * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import { SqlClient } from 'effect/sql'
import type { EntityEntry, EntityName, FieldEntry } from '../../migration'
import { StorageError, UniqueViolation } from '../../errors'
import type { Hlc } from '../../changes'
import type { InsertOf, PatchOf, PutOf, KeyOf, WhereOf } from '../types'
import * as queries from './queries'
import { stampReplicated } from './stamp'

/** Whether a write matched a row. */
export interface WriteResult {
  readonly matched: boolean
}

/** How many rows a write over a predicate matched. */
export interface WriteCount {
  readonly matched: number
}

export interface Tx {
  /**
   * The wall time shared by writes in this transaction. Use for creation times in custom
   * SQL.
   */
  readonly at: DateTime.Utc

  insert<E extends EntityEntry<any>>(
    entity: E,
    row: InsertOf<E>,
  ): Effect.Effect<void, StorageError | UniqueViolation>
  put<E extends EntityEntry<any>>(
    entity: E,
    row: PutOf<E>,
  ): Effect.Effect<void, StorageError | UniqueViolation>
  update<E extends EntityEntry<any>>(
    entity: E,
    key: KeyOf<E>,
    patch: PatchOf<E>,
  ): Effect.Effect<WriteResult, StorageError | UniqueViolation>
  remove<E extends EntityEntry<any>>(
    entity: E,
    key: KeyOf<E>,
  ): Effect.Effect<WriteResult, StorageError>
  removeWhere<E extends EntityEntry<any>>(
    entity: E,
    where: WhereOf<E>,
  ): Effect.Effect<WriteCount, StorageError>
  erase<E extends EntityEntry<any>>(
    entity: E,
    key: KeyOf<E>,
  ): Effect.Effect<WriteResult, StorageError>
  eraseWhere<E extends EntityEntry<any>>(
    entity: E,
    where: WhereOf<E>,
  ): Effect.Effect<WriteCount, StorageError>
}

/**
 * A transaction's connection, clock readings, and affected entity names. Row methods
 * stamp replicated field changes.
 * @internal
 */
export class TxImpl implements Tx {
  readonly touched: Set<EntityName>

  constructor(
    readonly sql: SqlClient.SqlClient,
    readonly hlc: Hlc,
    readonly at: DateTime.Utc,
  ) {
    this.touched = new Set<EntityName>()
  }

  /** Inserts a row and stamps changes for replication. Fails if the row exists. */
  insert<E extends EntityEntry<any>>(
    entity: E,
    row: InsertOf<E>,
  ): Effect.Effect<void, StorageError | UniqueViolation> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const rowId = queries.rowIdOf(entity, row)
      yield* refuseDuplicate(self.sql, entity, rowId, row, {})
      const stored = withCreationTime(entity, entity.withSupersededDefaults(row), {}, self.at)
      yield* queries.insertRow(self.sql, entity, stored)
      yield* stampReplicated(self.sql, entity, self.hlc, rowId, row, {}, stored)
      self.touched.add(entity.name)
    })
  }

  /**
   * Inserts or updates a row and stamps changes for replication.
   */
  put<E extends EntityEntry<any>>(
    entity: E,
    row: PutOf<E>,
  ): Effect.Effect<void, StorageError | UniqueViolation> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const rowId = queries.rowIdOf(entity, row)
      const found = yield* queries.findRow(self.sql, entity, row, { includeDeleted: true })
      const before = found ?? {}
      yield* refuseDuplicate(self.sql, entity, rowId, row, before)
      const created = found === undefined ? entity.withSupersededDefaults(row) : row
      const stored = withCreationTime(entity, created, before, self.at)
      yield* queries.upsertRow(self.sql, entity, stored, before)
      yield* stampReplicated(self.sql, entity, self.hlc, rowId, row, before, stored)
      self.touched.add(entity.name)
    })
  }

  /**
   * Updates a row by key and stamps changed replicated fields. Returns whether an active
   * row matched.
   */
  update<E extends EntityEntry<any>>(
    entity: E,
    key: KeyOf<E>,
    patch: PatchOf<E>,
  ): Effect.Effect<WriteResult, StorageError | UniqueViolation> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const rowId = queries.rowIdOf(entity, key)
      const before = yield* queries.findRow(self.sql, entity, key)
      if (before === undefined) return { matched: false }
      yield* refuseDuplicate(self.sql, entity, rowId, patch, before)
      const encoded = entity.encodeAll(patch)
      const matched = yield* queries.updateRow(self.sql, entity, key, encoded)
      if (matched) {
        yield* stampReplicated(self.sql, entity, self.hlc, rowId, key, before, patch)
        self.touched.add(entity.name)
      }
      return { matched }
    })
  }

  /**
   * Hides a row with a replicated deletion time. Returns whether an active row matched.
   */
  remove<E extends EntityEntry<any>>(
    entity: E,
    key: KeyOf<E>,
  ): Effect.Effect<WriteResult, StorageError> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const tombstone = yield* requireTombstone(entity)
      const rowId = queries.rowIdOf(entity, key)
      // Use column names for writes and field names for stamps because renames preserve
      // columns.
      const matched = yield* queries.updateRow(self.sql, entity, key, {
        [tombstone.column]: tombstone.encodeField(self.at),
      })
      if (matched) {
        yield* stampReplicated(
          self.sql,
          entity,
          self.hlc,
          rowId,
          key,
          {},
          {
            [tombstone.currentName!]: self.at,
          },
        )
        self.touched.add(entity.name)
      }
      return { matched }
    })
  }

  /**
   * Hides rows matching a filter and stamps each deletion. Requires a tombstone field.
   * Returns the number of matched rows.
   */
  removeWhere<E extends EntityEntry<any>>(
    entity: E,
    where: WhereOf<E>,
  ): Effect.Effect<WriteCount, StorageError> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      yield* requireTombstone(entity)
      const rows = yield* queries.listRows(self.sql, entity, { where })
      let matched = 0
      for (const row of rows) {
        const { matched: hit } = yield* self.remove(
          entity,
          queries.keyOfRow(entity, row) as KeyOf<E>,
        )
        if (hit) matched += 1
      }
      return { matched }
    })
  }

  /**
   * Physically deletes a row and its related metadata without replication. Rejects
   * entities with tombstones. Use {@link remove} for replicated deletion.
   */
  erase<E extends EntityEntry<any>>(
    entity: E,
    key: KeyOf<E>,
  ): Effect.Effect<WriteResult, StorageError> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      yield* refuseTombstone(entity)
      const matched = yield* queries.deleteRow(self.sql, entity, key)
      if (matched) self.touched.add(entity.name)
      return { matched }
    })
  }

  /**
   * Physically deletes matching rows and their related metadata. Rejects entities with
   * tombstones. Returns the number of matched rows.
   */
  eraseWhere<E extends EntityEntry<any>>(
    entity: E,
    where: WhereOf<E>,
  ): Effect.Effect<WriteCount, StorageError> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      yield* refuseTombstone(entity)
      const rows = yield* queries.listRows(self.sql, entity, { where })
      let matched = 0
      for (const row of rows) {
        const { matched: hit } = yield* self.erase(
          entity,
          queries.keyOfRow(entity, row) as KeyOf<E>,
        )
        if (hit) matched += 1
      }
      return { matched }
    })
  }
}

/**
 * Rejects writes that duplicate a live row's unique tuple on this peer. Skips the check
 * for entities without unique fields.
 */
const refuseDuplicate = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  rowId: string,
  incoming: Record<string, unknown>,
  stored: Record<string, unknown>,
): Effect.Effect<void, StorageError | UniqueViolation> => {
  if (entity.uniqueFields.length === 0) return Effect.void
  if (!entity.uniqueFields.some(field => field.currentName! in incoming)) return Effect.void

  const values: Record<string, unknown> = {}
  for (const field of entity.uniqueFields) {
    const name = field.currentName!
    const value = name in incoming ? field.encodeField(incoming[name]) : stored[field.column]
    // Skip the collision check while any unique tuple component is absent.
    if (value === undefined) return Effect.void
    values[name] = value
  }

  return queries
    .findUniqueRow(sql, entity, values, { exceptRowId: rowId })
    .pipe(
      Effect.flatMap(found =>
        found === undefined
          ? Effect.void
          : Effect.fail(new UniqueViolation({ entity: entity.name, values })),
      ),
    )
}

const withCreationTime = (
  entity: EntityEntry,
  row: Record<string, unknown>,
  before: Record<string, unknown>,
  at: DateTime.Utc,
): Record<string, unknown> => {
  const field = entity.createdField
  if (field === undefined) {
    return row
  }
  const stored = before[field.column]
  return {
    ...row,
    [field.currentName!]: stored == null ? at : field.decodeField(stored),
  }
}

const requireTombstone = (entity: EntityEntry): Effect.Effect<FieldEntry, StorageError> =>
  entity.tombstoneField === undefined
    ? Effect.fail(
        new StorageError({
          message: `'${entity.name}' declares no tombstone field. Use erase for physical deletion.`,
        }),
      )
    : Effect.succeed(entity.tombstoneField)

const refuseTombstone = (entity: EntityEntry): Effect.Effect<void, StorageError> =>
  entity.tombstoneField === undefined
    ? Effect.void
    : Effect.fail(
        new StorageError({
          message: `'${entity.name}' declares a tombstone field. Use remove for replicated deletion.`,
        }),
      )
