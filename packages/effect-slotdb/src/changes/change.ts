import { Schema } from 'effect'
import { Hlc } from './hlc'
import { EntityId, FieldId } from '../migration'

/**
 * A stamped field write addressed by entity, row, and field IDs. Decoding rejects
 * malformed IDs and accepts unknown IDs so older peers can relay newer fields.
 */
export class Change extends Schema.Class<Change>('Change')({
  entityId: EntityId,
  rowId: Schema.String,
  fieldId: FieldId,
  value: Schema.Unknown,
  hlc: Hlc,
}) {
  static readonly new = (
    entityId: EntityId,
    rowId: string,
    fieldId: FieldId,
    value: unknown,
    hlc: Hlc,
  ): Change => Change.make({ entityId, rowId, fieldId, value, hlc })
}

/** A batch of field-level changes. */
export const ChangeBatch = Schema.Array(Change)
export type ChangeBatch = typeof ChangeBatch.Type

/** Returns distinct entity IDs for invalidating reads after a batch. */
export const touchedEntities = (changes: ChangeBatch): ReadonlyArray<EntityId> => [
  ...new Set(changes.map(c => c.entityId)),
]

/** Returns a map key for a slot address. */
export const slotKey = (entityId: string, rowId: string, fieldId: string): string =>
  `${entityId}|${rowId}|${fieldId}`
