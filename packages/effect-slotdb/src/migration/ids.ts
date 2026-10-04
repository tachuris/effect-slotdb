import * as Schema from 'effect/Schema'

/** A 64-bit derived id, as 16 lowercase hex digits. */
const ID = /^[0-9a-f]{16}$/

const wellFormedId = (label: string) =>
  Schema.makeFilter<string>(value => ID.test(value) || `${label} is not a well-formed id`)

/** Identifies an entity by its original name. Renaming preserves the ID. */
export const EntityId = Schema.String.pipe(Schema.brand('EntityId')).check(wellFormedId('EntityId'))
export type EntityId = typeof EntityId.Type

/** Identifies a field within an entity. The pair (EntityId, FieldId) addresses a slot. */
export const FieldId = Schema.String.pipe(Schema.brand('FieldId')).check(wellFormedId('FieldId'))
export type FieldId = typeof FieldId.Type

// Use FNV-1a over UTF-8 bytes to derive consistent 64 bit IDs across builds.
// Schema derivation rejects detected collisions.
const FNV_OFFSET = 14_695_981_039_346_656_037n
const FNV_PRIME = 1_099_511_628_211n
const MASK_64 = 0xffffffffffffffffn

const fnv1a64Hex = (input: string): string => {
  let hash = FNV_OFFSET
  for (const byte of new TextEncoder().encode(input)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64
  }
  return hash.toString(16).padStart(16, '0')
}

/** Keys on the entity's birth name, so a rename leaves every id under it untouched. */
export const entityIdOf = (birthName: string): EntityId =>
  EntityId.make(fnv1a64Hex(`entity:${birthName}`))

/**
 * Derives a field ID from its original name and declaring migration file. Renaming
 * preserves the ID. Reusing a name in another migration produces a new ID.
 */
export const fieldIdOf = (birthName: string, bornIn: string): FieldId =>
  FieldId.make(fnv1a64Hex(`field:${birthName}:${bornIn}`))
