import * as Effect from 'effect/Effect'
import { SqlClient } from 'effect/sql'
import type { EntityEntry } from '../../migration'
import { mapStorageErrorMessage, StorageError } from '../../errors'
import { stampChanges } from '../../replication/sql/stamps'
import type { Hlc } from '../../changes'

/** Stamps replicated fields after row writes separate local fields from the patch. */

/** The field names a patch names that the entity declares local. */
const localNames = (entity: EntityEntry, patch: Record<string, unknown>): ReadonlyArray<string> =>
  Object.keys(patch).filter(name => entity.fieldByName(name)?.local === true)

/**
 * Stamps changed replicated fields, including key values for new rows. Unchanged fields
 * retain their stamps. Uses the key argument because update patches omit keys.
 */
export const stampReplicated = (
  sql: SqlClient.SqlClient,
  entity: EntityEntry,
  hlc: Hlc,
  rowId: string,
  key: Record<string, unknown>,
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): Effect.Effect<void, StorageError> =>
  Effect.gen(function* () {
    const local = new Set(localNames(entity, patch))
    const replicated: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(patch)) {
      if (local.has(name)) continue
      replicated[name] = value
    }
    if (Object.keys(replicated).length === 0) return
    // Convert natural key values to strings for row ID encoding.
    // Key schemas may be numeric, as in peerSyncState, so the conversion does not assume
    // strings.
    const keyFields = entity.keyFields.map(field => {
      const value = key[field.currentName!]
      return value === undefined || value === null ? '' : String(value as string | number)
    })
    const keys = entity.keyValues(keyFields)
    yield* stampChanges(sql, entity, hlc, rowId, before, {
      ...keys,
      ...replicated,
    })
  }).pipe(Effect.asVoid, mapStorageErrorMessage('Failed to stamp a write'))
