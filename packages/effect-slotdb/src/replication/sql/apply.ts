import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { SqlClient } from 'effect/sql'
import { mapStorageErrorMessage, StorageError } from '../../errors.ts'
import type { EntityEntry, FieldEntry, SchemaIndex } from '../../migration'
import { DEAD_LETTER_TABLE, OVERFLOW_TABLE, decodeRowId } from '../../migration'
import { Change, type ChangeBatch, Hlc } from '../../changes'
import { mergeSlot, type Slot } from '../merge.ts'
import { getHlc, putHlc } from './stamps.ts'

/**
 * Merges incoming changes using each field's policy and returns accepted changes.
 * Preserves unknown fields in overflow. Stores invalid known values as unstamped dead
 * letters.
 */
export const applyChanges = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
  changes: ChangeBatch,
): Effect.Effect<ChangeBatch, StorageError> =>
  Effect.gen(function* () {
    const winners: Array<Change> = []
    const byRow = new Map<string, Array<Change>>()

    for (const change of changes) {
      const key = `${change.entityId}|${change.rowId}`
      const group = byRow.get(key)
      if (group === undefined) byRow.set(key, [change])
      else group.push(change)
    }

    for (const group of byRow.values()) {
      winners.push(...(yield* applyRow(sql, index, group)))
    }
    return winners
  }).pipe(mapStorageErrorMessage('Failed to apply a change'))

/** One row's slots, resolved and merged together so the row is written once. */
const applyRow = (
  sql: SqlClient.SqlClient,
  index: SchemaIndex,
  group: ReadonlyArray<Change>,
): Effect.Effect<ReadonlyArray<Change>, StorageError> =>
  Effect.gen(function* () {
    const { entityId, rowId } = group[0]
    const entity = index.entities.get(entityId)

    // Preserve fields of unknown entities in overflow for later relay and decoding.
    if (entity === undefined) {
      return yield* storeOverflow(sql, group)
    }

    const columns: Record<string, unknown> = {}
    const winners: Array<Change> = []

    for (const change of group) {
      const field = entity.fieldsById.get(change.fieldId)
      if (field === undefined || field.local) {
        winners.push(...(yield* storeOverflow(sql, [change])))
        continue
      }

      const stored = yield* getHlc(sql, entityId, rowId, change.fieldId)
      const local = Option.isNone(stored)
        ? undefined
        : { value: yield* storedValue(sql, entity, field, rowId), stamp: stored.value }

      const merged = mergeStored(field, { value: change.value, stamp: change.hlc }, local)
      // Value comparisons can retain a value while accepting a later stamp.
      // Write the merged column value with that stamp.
      if (
        local !== undefined &&
        Hlc.compare(merged.stamp, local.stamp) <= 0 &&
        !changed(merged.value, local.value)
      ) {
        continue
      }

      const decoded = yield* decodable(sql, entity, field, change, merged.value)
      if (!decoded) continue
      // Log only changed values to avoid repeated warnings when the stamp changes.
      const arrived = local === undefined || changed(merged.value, local.value)
      if (arrived && undeclaredMember(field, merged.value)) {
        yield* Effect.logWarning('sync.unrecognized_member').pipe(
          Effect.annotateLogs({ ...slotAnnotations(entity, field, change), value: merged.value }),
        )
      }

      columns[field.column] = merged.value
      yield* putHlc(sql, entityId, rowId, change.fieldId, merged.stamp)
      winners.push(
        Change.make({
          entityId,
          rowId,
          fieldId: change.fieldId,
          value: merged.value,
          hlc: merged.stamp,
        }),
      )
    }

    if (Object.keys(columns).length > 0) {
      const written = yield* writeRow(sql, entity, rowId, columns)
      if (!written) {
        for (const winner of winners) {
          if (entity.fieldsById.has(winner.fieldId)) yield* writeOverflow(sql, winner)
        }
      }
    }
    return winners
  })

/**
 * Whether two stored values differ, compared the way the write-side diff compares them.
 */
const changed = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b)

/** Reads a slot from its row, or from pending overflow while the row remains absent. */
const storedValue = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  field: FieldEntry,
  rowId: string,
): Effect.Effect<unknown, StorageError> =>
  Effect.gen(function* () {
    const rows = yield* sql<Record<string, unknown>>`
    SELECT
      *
    FROM
      ${sql(entity.table)}
    WHERE
      __rowId = ${rowId}
    LIMIT
      1
  `
    if (rows.length > 0) return rows[0][field.column] ?? null
    const pending = yield* sql<{ readonly value: string }>`
      SELECT
        value
      FROM
        ${sql(OVERFLOW_TABLE)}
      WHERE
        entityId = ${entity.id}
        AND rowId = ${rowId}
        AND fieldId = ${field.id}
    `
    return pending.length === 0 ? null : (JSON.parse(pending[0].value) as unknown)
  }).pipe(mapStorageErrorMessage('Failed to read a slot'))

/**
 * Merges stored values using the declared policy. Decodes sets and flags before
 * comparison and encodes the merged result.
 */
const mergeStored = (
  field: FieldEntry,
  incoming: Slot<unknown, Hlc>,
  local: Slot<unknown, Hlc> | undefined,
): Slot<unknown, Hlc> => {
  const compare = (a: Hlc, b: Hlc) => Hlc.compare(a, b)
  if (field.policy !== 'union' && field.policy !== 'or' && field.policy !== 'and') {
    return mergeSlot(field.policy, incoming, local, compare)
  }

  const decode = (value: unknown) => {
    try {
      return field.decodeField(value)
    } catch {
      return value
    }
  }
  const merged = mergeSlot(
    field.policy,
    { value: decode(incoming.value), stamp: incoming.stamp },
    local === undefined ? undefined : { value: decode(local.value), stamp: local.stamp },
    compare,
  )
  // Preserve absence when both sets are absent. An empty list is a distinct stored value.
  const empty =
    field.policy === 'union' &&
    Array.isArray(merged.value) &&
    merged.value.length === 0 &&
    incoming.value === null &&
    (local === undefined || local.value === null)

  return { value: empty ? null : encodeOrKeep(field, merged.value), stamp: merged.stamp }
}

const encodeOrKeep = (field: FieldEntry, value: unknown): unknown => {
  try {
    return field.encodeField(value)
  } catch {
    return value
  }
}

/**
 * Checks whether a merged value decodes and records a dead letter on failure. Leaves the
 * stamp unchanged when decoding fails.
 */
const decodable = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  field: FieldEntry,
  change: Change,
  value: unknown,
): Effect.Effect<boolean, StorageError> =>
  Effect.gen(function* () {
    const result = yield* Effect.result(Effect.try(() => field.decodeField(value)))
    if (result._tag === 'Success') return true

    yield* sql`
      INSERT INTO
        ${sql(DEAD_LETTER_TABLE)} ${sql.insert({
          entityId: change.entityId,
          rowId: change.rowId,
          fieldId: change.fieldId,
          value: JSON.stringify(value ?? null),
          hlc: `${change.hlc.millis}:${change.hlc.counter}:${change.hlc.node}`,
          reason: String(result.failure),
        })}
      ON CONFLICT (entityId, rowId, fieldId) DO UPDATE
      SET
        value = excluded.value,
        hlc = excluded.hlc,
        reason = excluded.reason
    `.pipe(mapStorageErrorMessage('Failed to record a dead letter'))
    yield* Effect.logWarning('sync.dead_letter').pipe(
      Effect.annotateLogs(slotAnnotations(entity, field, change)),
    )
    return false
  })

/** Returns slot IDs and application names for log annotations. */
const slotAnnotations = (entity: EntityEntry, field: FieldEntry, change: Change) => ({
  entityId: change.entityId,
  rowId: change.rowId,
  fieldId: change.fieldId,
  entity: entity.name,
  field: field.currentName ?? field.birthName,
})

/** Checks whether a string is an undeclared member of an open literal union. */
const undeclaredMember = (field: FieldEntry, value: unknown): boolean =>
  field.openMembers !== undefined && typeof value === 'string' && !field.openMembers.includes(value)

/** Writes a row, or returns false while a required column lacks a value. */
const writeRow = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  rowId: string,
  columns: Record<string, unknown>,
): Effect.Effect<boolean, StorageError> =>
  Effect.gen(function* () {
    const existing = yield* sql`
      SELECT
        1 AS one
      FROM
        ${sql(entity.table)}
      WHERE
        __rowId = ${rowId}
      LIMIT
        1
    `
    const restoredFieldIds: FieldEntry['id'][] = []
    if (existing.length === 0) {
      const pending = yield* sql<{ readonly fieldId: FieldEntry['id']; readonly value: string }>`
        SELECT
          fieldId,
          value
        FROM
          ${sql(OVERFLOW_TABLE)}
        WHERE
          entityId = ${entity.id}
          AND rowId = ${rowId}
      `
      const values: Record<string, unknown> = {
        __rowId: rowId,
        ...entity.keyColumnValues(decodeRowId(rowId)),
      }
      for (const slot of pending) {
        const field = entity.fieldsById.get(slot.fieldId)
        if (field === undefined || field.local) continue
        values[field.column] = JSON.parse(slot.value) as unknown
        restoredFieldIds.push(slot.fieldId)
      }
      Object.assign(values, columns)
      const specs = yield* sql<{
        readonly name: string
        readonly notnull: number
        readonly dflt_value: string | null
      }>`
  SELECT
    name,
    "notnull",
    dflt_value
  FROM
    pragma_table_info (${entity.table})
`
      if (
        specs.some(
          spec =>
            spec.notnull === 1 &&
            (spec.dflt_value === null || spec.dflt_value.toUpperCase() === 'NULL') &&
            values[spec.name] === undefined,
        )
      ) {
        return false
      }
      yield* sql`
        INSERT INTO
          ${sql(entity.table)} ${sql.insert(values)}
      `
    } else {
      yield* sql`
        UPDATE ${sql(entity.table)}
        SET
          ${sql.update(columns)}
        WHERE
          __rowId = ${rowId}
      `
    }
    const replacedFieldIds = Object.keys(columns).flatMap(column => {
      const field = entity.fieldByColumnKey(column)
      return field === undefined ? [] : [field.id]
    })
    yield* sql`
      DELETE FROM ${sql(OVERFLOW_TABLE)}
      WHERE
        entityId = ${entity.id}
        AND rowId = ${rowId}
        AND ${sql.in('fieldId', [...restoredFieldIds, ...replacedFieldIds])}
    `
    return true
  }).pipe(mapStorageErrorMessage('Failed to write a row'))

/**
 * Stores and stamps an unknown field in overflow so other peers can receive the value.
 */
const storeOverflow = (
  sql: SqlClient.SqlClient,
  group: ReadonlyArray<Change>,
): Effect.Effect<ReadonlyArray<Change>, StorageError> =>
  Effect.gen(function* () {
    const winners: Array<Change> = []
    for (const change of group) {
      const stored = yield* getHlc(sql, change.entityId, change.rowId, change.fieldId)
      if (Option.isSome(stored) && Hlc.compare(change.hlc, stored.value) <= 0) continue

      yield* writeOverflow(sql, change)
      yield* putHlc(sql, change.entityId, change.rowId, change.fieldId, change.hlc)
      winners.push(change)
    }
    return winners
  })

const writeOverflow = (
  sql: SqlClient.SqlClient,
  change: Change,
): Effect.Effect<void, StorageError> =>
  sql`
    INSERT INTO
      ${sql(OVERFLOW_TABLE)} ${sql.insert({
        entityId: change.entityId,
        rowId: change.rowId,
        fieldId: change.fieldId,
        value: JSON.stringify(change.value ?? null),
      })}
    ON CONFLICT (entityId, rowId, fieldId) DO UPDATE
    SET
      value = excluded.value
  `.pipe(Effect.asVoid, mapStorageErrorMessage('Failed to store a pending field'))
