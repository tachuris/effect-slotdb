import { Statement } from 'effect/sql'
import { type EntityEntry } from '../../migration'
import { decodeRow } from '../types'
import type { RowOf } from '../types'

/** The column list and decoder for a hand-written join. */
export interface Projection<Row> {
  /** The aliased column list, ready to splice into a `SELECT`. */
  readonly columns: Statement.Fragment
  /** Decode a row of result columns into the app-facing shape. */
  readonly decode: (row: Record<string, unknown>) => Row
}

/** The projection of an entity's columns, minus the tombstone and any omitted names. */
export const projectionOf = <E extends EntityEntry<any>, K extends keyof RowOf<E> & string = never>(
  entity: E,
  options: {
    readonly alias?: string
    readonly coalesceDefaults?: boolean
    readonly omit?: ReadonlyArray<K>
  } = {},
): Projection<Omit<RowOf<E>, K>> => {
  const alias = options.alias ?? entity.table
  const omit = new Set(options.omit ?? [])
  const columns: Statement.Fragment[] = []

  for (const field of entity.columnFields) {
    if (field.framework === 'tombstone') continue
    if (omit.has(field.currentName as K)) continue

    const key = field.column
    const column = `${alias}.${field.column}`
    const { columnDefault } = field
    if (options.coalesceDefaults && columnDefault != null) {
      columns.push(
        Statement.fragment([
          Statement.literal(`COALESCE(${column}, ?) AS "${key}"`, [columnDefault]),
        ]),
      )
    } else {
      columns.push(Statement.fragment([Statement.literal(`${column} AS "${key}"`)]))
    }
  }

  return {
    columns: Statement.join(', ', false)(columns),
    decode: row => decodeRow(entity, row),
  }
}

/**
 * Returns a SQL condition excluding tombstoned rows. Returns true for entities without
 * tombstones.
 */
export const livePredicate = (entity: EntityEntry, alias?: string): Statement.Fragment => {
  const field = entity.tombstoneField
  if (field === undefined) {
    return Statement.fragment([Statement.literal('1 = 1')])
  }
  const column = alias === undefined ? field.column : `${alias}.${field.column}`
  return Statement.fragment([Statement.literal(`${column} IS NULL`)])
}
