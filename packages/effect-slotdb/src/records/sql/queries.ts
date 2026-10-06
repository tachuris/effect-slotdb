import * as Effect from 'effect/Effect'
import { SqlClient } from 'effect/sql'
import {
  encodeRowId,
  type EntityEntry,
  STAMPS_TABLE,
  OVERFLOW_TABLE,
  DEAD_LETTER_TABLE,
} from '../../migration'
import { mapStorageErrorMessage, StorageError } from '../../errors'
import type { Comparison } from '../types'

/** Encodes a row ID from key values in the order declared by the migration chain. */
export const rowIdOf = (entity: EntityEntry, key: Record<string, unknown>): string =>
  encodeRowId(entity.keyFields.map(field => String(key[field.currentName!])))

/** Returns column names for SELECT in a stable order, separated by commas. */
const selectColumns = (entity: EntityEntry): string => entity.selectColumns.join(', ')

/**
 * The key columns as a where clause, with positional parameters, under the given alias.
 */
const keyWhere = (entity: EntityEntry, alias: string): string =>
  entity.keyFields.map(field => `${alias}.${field.column} = ?`).join(' AND ')

const COMPARISONS = { gt: '>', gte: '>=', lt: '<', lte: '<=' } as const

const isComparison = (value: unknown): value is Comparison =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One field's filter, as clauses and their parameters. */
const comparisonClauses = (
  column: string,
  value: unknown,
): { readonly clauses: ReadonlyArray<string>; readonly params: ReadonlyArray<unknown> } => {
  if (!isComparison(value)) {
    // Use IS NULL for absent values because equality with NULL does not match rows.
    if (value === null) return { clauses: [`${column} IS NULL`], params: [] }
    return { clauses: [`${column} = ?`], params: [value] }
  }

  const clauses: string[] = []
  const params: unknown[] = []

  for (const [name, operator] of Object.entries(COMPARISONS)) {
    const bound = value[name as keyof typeof COMPARISONS]
    if (bound === undefined) continue
    clauses.push(`${column} ${operator} ?`)
    params.push(bound)
  }

  if (value.in !== undefined) {
    if (value.in.length === 0) {
      // Use a false condition for empty membership filters.
      clauses.push('0 = 1')
    } else {
      clauses.push(`${column} IN (${value.in.map(() => '?').join(', ')})`)
      params.push(...value.in)
    }
  }

  return { clauses, params }
}

/**
 * A filter over named fields, as clauses and their parameters. Fails on a field the chain
 * does not declare live.
 */
const filterClauses = (
  entity: EntityEntry,
  where: Record<string, unknown>,
): { readonly clauses: ReadonlyArray<string>; readonly params: ReadonlyArray<unknown> } => {
  const clauses: string[] = []
  const params: unknown[] = []

  for (const [name, value] of Object.entries(where)) {
    const field = entity.fieldByName(name)
    if (field === undefined) {
      throw new StorageError({ message: `Field "${name}" of "${entity.table}" is not live` })
    }
    const built = comparisonClauses(field.column, value)
    clauses.push(...built.clauses)
    params.push(...built.params)
  }

  return { clauses, params }
}

/** Returns key values from a stored row using application field names. */
export const keyOfRow = (
  entity: EntityEntry,
  row: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(entity.keyFields.map(field => [field.currentName!, row[field.column]]))

/** Reads a row by key. Excludes tombstoned rows unless `includeDeleted` is true. */
export const findRow = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  key: Record<string, unknown>,
  options: { readonly includeDeleted?: boolean } = {},
): Effect.Effect<Record<string, unknown> | undefined, StorageError> => {
  const keys = entity.keyFields.map(field => String(key[field.currentName!]))
  const tomb = entity.tombstoneField?.column
  const clause = options.includeDeleted || tomb === undefined ? '' : ` AND ${tomb} IS NULL`
  return sql
    .unsafe(
      `SELECT ${selectColumns(entity)} FROM ${entity.table} WHERE ${keyWhere(entity, entity.table)}${clause} LIMIT 1`,
      keys,
    )
    .pipe(
      Effect.map(rows => rows[0] as Record<string, unknown> | undefined),
      mapStorageErrorMessage('Failed to read a row'),
    )
}

/**
 * Reads the live row with a unique tuple, selecting the lowest row ID. `exceptRowId`
 * excludes the row being updated. Rejects entities without unique fields.
 */
export const findUniqueRow = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  values: Record<string, unknown>,
  options: { readonly exceptRowId?: string } = {},
): Effect.Effect<Record<string, unknown> | undefined, StorageError> => {
  if (entity.uniqueFields.length === 0) {
    return Effect.fail(
      new StorageError({
        message: `'${entity.name}' declares no unique field. Declare unique fields before reading by a unique tuple.`,
      }),
    )
  }

  const clauses = entity.uniqueFields.map(field => `${field.column} = ?`)
  const params: unknown[] = entity.uniqueFields.map(field => values[field.currentName!])

  const tomb = entity.tombstoneField?.column
  if (tomb !== undefined) clauses.push(`${tomb} IS NULL`)
  if (options.exceptRowId !== undefined) {
    clauses.push('__rowId <> ?')
    params.push(options.exceptRowId)
  }

  return sql
    .unsafe(
      `SELECT ${selectColumns(entity)} FROM ${entity.table} WHERE ${clauses.join(' AND ')} ORDER BY __rowId LIMIT 1`,
      params as ReadonlyArray<unknown>,
    )
    .pipe(
      Effect.map(rows => rows[0] as Record<string, unknown> | undefined),
      mapStorageErrorMessage('Failed to read a row by its unique values'),
    )
}

/**
 * Reads rows matching encoded field filters with optional ordering. Excludes tombstoned
 * rows unless `includeDeleted` is true.
 */
export const listRows = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  options: {
    readonly where?: Record<string, unknown>
    readonly orderBy?: string
    readonly includeDeleted?: boolean
  } = {},
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, StorageError> => {
  const whereClauses: string[] = []
  const params: unknown[] = []

  if (options.where !== undefined) {
    let built
    try {
      built = filterClauses(entity, options.where)
    } catch (cause) {
      return Effect.fail(
        cause instanceof StorageError
          ? cause
          : new StorageError({ message: 'Failed to build a filter', cause }),
      )
    }
    whereClauses.push(...built.clauses)
    params.push(...built.params)
  }

  const tomb = entity.tombstoneField?.column
  if (!options.includeDeleted && tomb !== undefined) whereClauses.push(`${tomb} IS NULL`)

  const where = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : ''
  const order =
    options.orderBy !== undefined ? ` ORDER BY ${entity.fieldByName(options.orderBy)?.column}` : ''
  return sql
    .unsafe(
      `SELECT ${selectColumns(entity)} FROM ${entity.table}${where}${order}`,
      params as ReadonlyArray<unknown>,
    )
    .pipe(
      Effect.map(rows => rows as ReadonlyArray<Record<string, unknown>>),
      mapStorageErrorMessage('Failed to list rows'),
    )
}

/** Returns insert columns, including key fields and the row ID. */
const insertColumns = (
  entity: EntityEntry,
  row: Record<string, unknown>,
): { readonly rowId: string; readonly values: Record<string, unknown> } => {
  // Use stored column names for keys so renamed fields address existing columns.
  const keyValues = entity.keyColumnValues(
    entity.keyFields.map(field => String(row[field.currentName!])),
  )
  const rowId = rowIdOf(entity, row)
  return { rowId, values: { __rowId: rowId, ...keyValues, ...entity.encodeAll(row) } }
}

/**
 * Inserts a row with its natural key values and derived row ID. Fails if the row exists.
 */
export const insertRow = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  row: Record<string, unknown>,
): Effect.Effect<void, StorageError> => {
  const { values } = insertColumns(entity, row)
  return sql`
    INSERT INTO
      ${sql(entity.table)} ${sql.insert(values)}
  `.pipe(Effect.asVoid, mapStorageErrorMessage('Failed to insert a row'))
}

/**
 * Inserts or updates a row. `stored` fills omitted columns for SQLite's NOT NULL check
 * before conflict resolution. Updates use only supplied columns.
 */
export const upsertRow = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  row: Record<string, unknown>,
  stored: Record<string, unknown>,
): Effect.Effect<void, StorageError> => {
  const { values } = insertColumns(entity, row)
  const keyColumns = entity.keyColumns.join(', ')
  // Update only supplied columns to preserve omitted values and local fields.
  // Exclude framework columns so puts retain the original creation time.
  const setColumns = Object.keys(values)
    .map(columnKey => entity.fieldByColumnKey(columnKey))
    .filter(
      (field): field is NonNullable<typeof field> =>
        field !== undefined && field.keyPosition === undefined && field.framework === undefined,
    )
    .map(field => `${field.column} = excluded.${field.column}`)
    .join(', ')
  // Use DO NOTHING when the row contains only key fields and has no columns to update.
  const onConflict =
    setColumns.length === 0
      ? sql.unsafe('DO NOTHING')
      : sql`
  DO UPDATE
  SET
    ${sql.unsafe(setColumns)}
`
  return sql`
    INSERT INTO
      ${sql(entity.table)} ${sql.insert({ ...stored, ...values })}
    ON CONFLICT (${sql.unsafe(keyColumns)}) ${onConflict}
  `.pipe(Effect.asVoid, mapStorageErrorMessage('Failed to upsert a row'))
}

/**
 * Updates columns named by a patch without stamping. Returns whether an active row
 * matched using `UPDATE ... RETURNING`.
 */
export const updateRow = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  key: Record<string, unknown>,
  encoded: Record<string, unknown>,
): Effect.Effect<boolean, StorageError> => {
  const keys = entity.keyFields.map(field => String(key[field.currentName!]))
  const tomb = entity.tombstoneField?.column
  // Encoded values use column result keys.
  const setEntries = Object.entries(encoded).map(([resultKey, value]) => {
    const field = entity.fieldByColumnKey(resultKey)
    return { column: field?.column ?? resultKey, value }
  })
  const setClause = setEntries.map(({ column }) => `${column} = ?`).join(', ')
  const whereClauses = entity.keyFields.map(field => `${field.column} = ?`)
  if (tomb !== undefined) whereClauses.push(`${tomb} IS NULL`)
  return sql
    .unsafe(
      `UPDATE ${entity.table} SET ${setClause} WHERE ${whereClauses.join(' AND ')} RETURNING __rowId`,
      [...setEntries.map(e => e.value), ...keys] as ReadonlyArray<unknown>,
    )
    .pipe(
      Effect.map(rows => rows.length > 0),
      mapStorageErrorMessage('Failed to update a row'),
    )
}

/**
 * Physically deletes a row and its stamps, overflow values, and dead letters. Returns
 * whether a row matched the key.
 */
export const deleteRow = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  key: Record<string, unknown>,
): Effect.Effect<boolean, StorageError> => {
  const keys = entity.keyFields.map(field => String(key[field.currentName!]))
  const whereClauses = entity.keyFields.map(field => `${field.column} = ?`)
  return sql
    .unsafe(
      `DELETE FROM ${entity.table} WHERE ${whereClauses.join(' AND ')} RETURNING __rowId`,
      keys,
    )
    .pipe(
      Effect.flatMap(rows =>
        rows.length === 0
          ? Effect.succeed(false)
          : deleteSideRows(sql, entity, rowIdOf(entity, key)).pipe(Effect.as(true)),
      ),
      mapStorageErrorMessage('Failed to erase a row'),
    )
}

const deleteSideRows = (sql: SqlClient.SqlClient, entity: EntityEntry, rowId: string) =>
  Effect.forEach(
    [STAMPS_TABLE, OVERFLOW_TABLE, DEAD_LETTER_TABLE],
    table => sql`
      DELETE FROM ${sql(table)}
      WHERE
        entityId = ${entity.id}
        AND rowId = ${rowId}
    `,
    { discard: true },
  )
