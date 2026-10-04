import type { SchemaIndex, EntityId, FieldId } from '../migration'
import { encodeRowId } from '../migration'
import { Change, type ChangeBatch, type Hlc, touchedEntities } from '../changes'

/**
 * Resolves table names, keys, and field names to slot addresses using a bound schema
 * index.
 */
export const makeAddressing = (index: SchemaIndex) => {
  const entityIdFor = (table: string): EntityId => index.entityForTable(table).id

  const fieldIdFor = (table: string, name: string): FieldId => {
    const entity = index.entityForTable(table)
    const field = entity.fieldByName(name)
    if (field === undefined) throw new Error(`sync: '${table}.${name}' is not a live field`)
    return field.id
  }

  /** Constructs a change from a table name, row key, and field name. */
  const change = (
    table: string,
    keys: ReadonlyArray<string>,
    field: string,
    value: unknown,
    hlc: Hlc,
  ): Change =>
    Change.make({
      entityId: index.entityForTable(table).id,
      rowId: encodeRowId(keys),
      fieldId: fieldIdFor(table, field),
      value,
      hlc,
    })

  /** The table a change addresses, for checking on a batch. */
  const tableOf = (c: Change): string | undefined => index.entities.get(c.entityId)?.table

  /** The field name a change addresses, for checking on a batch. */
  const fieldOf = (c: Change): string | undefined => {
    const field = index.entities.get(c.entityId)?.fieldsById.get(c.fieldId)
    return field?.currentName ?? field?.birthName
  }

  /** Returns known table names affected by a batch for invalidating reads. */
  const touchedTables = (changes: ChangeBatch): ReadonlyArray<string> =>
    touchedEntities(changes)
      .map(id => index.entities.get(id)?.table)
      .filter((table): table is string => table !== undefined)

  return { entityIdFor, fieldIdFor, change, tableOf, fieldOf, touchedTables }
}
