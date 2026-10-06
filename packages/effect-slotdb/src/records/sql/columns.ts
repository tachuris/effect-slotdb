import type { EntityEntry, FieldEntry } from '../../migration'

const REMEDY = 'Read the field through decode, or COALESCE both columns'

/**
 * Asserts that each column a hand-written query names still stores a live field that
 * supersedes no retired slot.
 */
export const assertLiveColumns = (entity: EntityEntry, columns: ReadonlyArray<string>): void => {
  for (const column of columns) liveField(entity, column)
}

const liveField = (entity: EntityEntry, column: string): FieldEntry => {
  const field = entity.fieldByColumnKey(column)
  const named = `hand-written SQL names '${entity.table}.${column}'`
  if (field === undefined) {
    throw new Error(`${named}, but no field of '${entity.name}' stores it`)
  }
  // A retype leaves the plain column with the retired field, so a query that names the
  // column reads stale values.
  if (field.currentName === undefined) {
    throw new Error(`${named}, which belongs to the retired field '${field.birthName}'. ${REMEDY}`)
  }
  // Rows written before the retype, or by older peers, fill only the retired column.
  if (field.supersedes !== undefined) {
    throw new Error(
      `${named}, whose field '${field.currentName}' supersedes a retired slot that SQL cannot read. ${REMEDY}`,
    )
  }
  return field
}

/**
 * Rejects raw writes to replicated fields and to columns that no longer store a live
 * field.
 */
export const assertWritableColumns = (
  entity: EntityEntry,
  columns: ReadonlyArray<string>,
): void => {
  for (const column of columns) {
    const field = liveField(entity, column)
    if (!field.local) {
      throw new Error(
        `hand-written SQL writes '${entity.table}.${column}', which stores the replicated field '${field.currentName}'. Use the typed row methods to encode and stamp the change`,
      )
    }
  }
}
