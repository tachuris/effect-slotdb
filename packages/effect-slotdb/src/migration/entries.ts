import * as Data from 'effect/Data'
import * as Schema from 'effect/Schema'
import { FrameworkRole, MergePolicy } from './annotations.ts'
import { EntityId, FieldId } from './ids.ts'
import { EntityName } from './migration.ts'

const acceptsTag =
  (tag: 'Null' | 'Undefined') =>
  (ast: unknown): boolean => {
    if (ast === undefined) return false
    if ((ast as { readonly _tag?: string })._tag === tag) return true
    const types = (ast as { readonly types?: ReadonlyArray<unknown> }).types
    return types === undefined ? false : types.some(acceptsTag(tag))
  }

const acceptsUndefined = acceptsTag('Undefined')
const acceptsNull = acceptsTag('Null')

interface FieldEntryFields {
  readonly id: FieldId
  readonly entity: EntityId
  readonly birthName: string
  readonly bornIn: string
  readonly column: string
  /** The current application name, absent for fields outside the current shape. */
  readonly currentName?: string
  readonly kind: 'stored' | 'derived'
  readonly policy: MergePolicy
  /** Position in the natural key, starting at 1, or undefined for other fields. */
  readonly keyPosition?: number
  /** Position in the unique tuple, starting at 1, or undefined for other fields. */
  readonly uniquePosition?: number
  /** Whether the field has a stored column but is excluded from replication. */
  readonly local: boolean
  /** The encoded column default, absent for fields without a default. */
  readonly columnDefault?: unknown
  readonly materialize: boolean
  /** The framework's field role, absent for fields written by the application. */
  readonly framework?: FrameworkRole
  readonly writable: boolean
  readonly derivedFrom?: ReadonlyArray<FieldId>
  readonly supersedes?: ReadonlyArray<FieldId>
  readonly fallbackDecode?: (old: unknown) => unknown
  /** Maps a value to the superseded field's type so writes also fill the retired slot. */
  readonly fallbackEncode?: (value: unknown) => unknown
  readonly combine?: (a: unknown, b: unknown) => unknown
  readonly split?: (value: unknown) => readonly [unknown, unknown]
  /** The declared members of an open literal union, absent for other stored types. */
  readonly openMembers?: ReadonlyArray<string>
  /** The encoded type fingerprint used to compare stored field types. */
  readonly typeFingerprint: string
  /**
   * The encoded type and merge policy fingerprint. Changes require `retype`, except
   * additions to open literal member lists, to preserve compatibility with older peers.
   */
  readonly fingerprint: string
  readonly schema: Schema.Top
}

export class FieldEntry extends Data.Class<FieldEntryFields> {
  // Cache field parsers to avoid allocating wrapper closures for each decoded row.
  #decode?: (raw: unknown) => unknown
  #encode?: (value: unknown) => unknown

  decodeField(raw: unknown): unknown {
    // SQL represents absent values as NULL. Optional schemas use undefined.
    const value =
      raw === null && acceptsUndefined((this.schema as { readonly ast?: unknown }).ast)
        ? undefined
        : raw
    // The parser accepts the field schema despite the broader derived schema type.
    this.#decode ??= Schema.decodeUnknownSync(this.schema as Schema.Codec<unknown, unknown>)
    return this.#decode(value)
  }

  /** Whether the field decodes SQL NULL, as a nullable or optional field does. */
  acceptsAbsent(): boolean {
    const ast = (this.schema as { readonly ast?: unknown }).ast
    return acceptsNull(ast) || acceptsUndefined(ast)
  }

  encodeField(value: unknown): unknown {
    this.#encode ??= Schema.encodeUnknownSync(this.schema as Schema.Codec<unknown, unknown>)
    return this.#encode(value)
  }
}

const KEY_VALUES_SEPARATOR = '|'

/**
 * Derives a readable row ID from natural key values. Peers creating the same logical row
 * derive the same ID independently.
 */
export const encodeRowId = (keyValues: ReadonlyArray<string>): string =>
  keyValues.join(KEY_VALUES_SEPARATOR)

/** Returns the key values encoded in a row ID, in key order. */
export const decodeRowId = (rowId: string): ReadonlyArray<string> =>
  rowId.split(KEY_VALUES_SEPARATOR)

interface EntityEntryFields {
  readonly id: EntityId
  readonly birthName: EntityName
  readonly name: EntityName
  readonly table: string
  readonly schema: Schema.Top
  /** Maps current application field names to field IDs. */
  readonly liveFieldIds: ReadonlyMap<string, FieldId>
  /**
   * All field IDs assigned by the chain. Retired fields retain their columns and codecs.
   */
  readonly fieldsById: ReadonlyMap<FieldId, FieldEntry>
  readonly retiredFields: ReadonlySet<FieldId>
  /**
   * Fields removed from the current shape but still replicated as sources of a live
   * projection.
   */
  readonly syncedSources: ReadonlySet<FieldId>
}

/**
 * An entity's field identities, columns, and storage codecs. `_Fields` records declared
 * field types for typed row operations and defaults to `unknown`.
 */
export class EntityEntry<_Fields = unknown> extends Data.Class<EntityEntryFields> {
  /** The key fields, in key order. */
  readonly keyFields: ReadonlyArray<FieldEntry>

  /** The key columns, in key order, as SQL identifiers. */
  readonly keyColumns: ReadonlyArray<string>

  /** The live fields in the unique tuple, in declared position order. */
  readonly uniqueFields: ReadonlyArray<FieldEntry>

  /** The unique columns, in tuple order, as SQL identifiers. */
  readonly uniqueColumns: ReadonlyArray<string>

  /**
   * Fields with stored columns, including retired fields and materialized derived fields.
   * Ordered by column name to match generated DDL.
   */
  readonly columnFields: ReadonlyArray<FieldEntry>

  /** The fields in the application shape, in declaration order. */
  readonly liveFields: ReadonlyArray<FieldEntry>

  /** The columns a raw SELECT needs, in a stable order. */
  readonly selectColumns: ReadonlyArray<string>

  /** The framework fields excluded from application writes. */
  readonly frameworkFields: ReadonlyArray<FieldEntry>

  /**
   * The tombstone field, if declared. Entities without a tombstone permit physical
   * deletion.
   */
  readonly tombstoneField?: FieldEntry

  /** The creation time field, if declared. */
  readonly createdField?: FieldEntry

  // Index stored columns by their field so diffs can resolve field IDs.
  readonly #byColumnKey = new Map<string, FieldEntry>()

  // Cache column and field lists because entity entries are immutable.
  constructor(fields: EntityEntryFields) {
    super(fields)

    const all = [...this.fieldsById.values()]
    this.keyFields = all
      .filter(field => field.keyPosition !== undefined)
      .sort((a, b) => a.keyPosition! - b.keyPosition!)
    this.keyColumns = this.keyFields.map(field => field.column)
    this.uniqueFields = this.#tupleFields(all)
    this.uniqueColumns = this.uniqueFields.map(field => field.column)
    this.columnFields = all
      .filter(field => field.kind === 'stored' || field.materialize)
      .sort((a, b) => (a.column < b.column ? -1 : 1))
    this.liveFields = [...this.liveFieldIds.values()].map(id => this.fieldsById.get(id)!)

    this.selectColumns = this.columnFields.map(field => field.column)
    for (const field of this.columnFields) {
      this.#byColumnKey.set(field.column, field)
    }

    this.frameworkFields = all.filter(field => field.framework !== undefined)
    this.tombstoneField = this.#roleField('tombstone')
    this.createdField = this.#roleField('created')
  }

  /**
   * Returns live unique fields in position order. Rejects duplicate positions to keep
   * index and read ordering consistent.
   */
  #tupleFields(all: ReadonlyArray<FieldEntry>): ReadonlyArray<FieldEntry> {
    const fields = all
      .filter(field => field.uniquePosition !== undefined && field.currentName !== undefined)
      .sort((a, b) => a.uniquePosition! - b.uniquePosition!)

    const positions = new Set(fields.map(field => field.uniquePosition))
    if (positions.size !== fields.length) {
      throw new Error(
        `migration: '${this.birthName}' declares two unique fields at one position (${fields
          .map(field => `${field.birthName}=${field.uniquePosition}`)
          .join(', ')}). A position belongs to at most one field`,
      )
    }

    return fields
  }

  /**
   * Returns the field with the requested framework role, or undefined. Rejects duplicate
   * roles.
   */
  #roleField(role: FrameworkRole): FieldEntry | undefined {
    const matches = this.frameworkFields.filter(field => field.framework === role)
    if (matches.length > 1) {
      throw new Error(
        `migration: '${this.birthName}' declares ${matches.length} '${role}' fields (${matches
          .map(field => field.birthName)
          .join(', ')}). A role belongs to at most one field`,
      )
    }
    return matches[0]
  }

  /** Returns the live field with the requested application name, or undefined. */
  fieldByName(name: string): FieldEntry | undefined {
    const id = this.liveFieldIds.get(name)
    return id === undefined ? undefined : this.fieldsById.get(id)
  }

  /**
   * Returns model field schemas by name. Excludes keys, framework fields, local fields,
   * and derived fields.
   */
  modelFields(): Record<string, Schema.Top> {
    const fields: Record<string, Schema.Top> = {}
    for (const field of this.liveFields) {
      if (field.keyPosition !== undefined || field.framework !== undefined || field.local) continue
      if (field.kind === 'derived') continue
      fields[field.currentName!] = field.schema
    }
    return fields
  }

  /**
   * Returns natural key values by field name for replication. Including key values lets
   * peers reconstruct rows from field changes.
   */
  keyValues(keys: ReadonlyArray<string>): Record<string, unknown> {
    return Object.fromEntries(this.keyFields.map((field, i) => [field.currentName!, keys[i]]))
  }

  /**
   * Returns natural key values by column name for storage. Renaming a key field preserves
   * the original column name.
   */
  keyColumnValues(keys: ReadonlyArray<string>): Record<string, unknown> {
    return Object.fromEntries(this.keyFields.map((field, i) => [field.column, keys[i]]))
  }

  /**
   * Returns the field for a column result key, or undefined. Maps changed columns to
   * field IDs for stamping.
   */
  fieldByColumnKey(columnKey: string): FieldEntry | undefined {
    return this.#byColumnKey.get(columnKey)
  }

  /** Decodes a row of column values into the application shape. */
  decode(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}

    for (const field of this.liveFields) {
      const name = field.currentName!

      // Compute derived fields from sources unless the field has a materialized column.
      if (field.kind === 'derived' && !field.materialize) {
        const [left, right] = field.derivedFrom!
        const a = this.#valueOf(row, left)
        const b = this.#valueOf(row, right)
        if (a === undefined && b === undefined) continue
        out[name] = field.combine!(a, b)
        continue
      }

      const raw = row[field.column]
      if (raw !== undefined && raw !== null) {
        out[name] = field.decodeField(raw)
        continue
      }

      // Read a retired slot when the replacement column is missing or NULL. A required
      // field with a fallback has no SQL default, so decoding applies the field default.
      const fallback = this.#supersededValue(row, field)
      if (fallback !== undefined) out[name] = fallback
      else if (raw === null) out[name] = field.decodeField(this.#unwrittenValue(field))
    }

    return out
  }

  /**
   * Adds the default or absent value of omitted fields with `encodeToOld`, so new rows
   * fill the superseded columns instead of leaving the column defaults there.
   */
  withSupersededDefaults(row: Record<string, unknown>): Record<string, unknown> {
    const out = { ...row }
    for (const field of this.liveFields) {
      const name = field.currentName!
      if (name in out || field.fallbackEncode === undefined) continue
      if (field.columnDefault !== undefined) out[name] = field.decodeField(field.columnDefault)
      else if (field.acceptsAbsent()) out[name] = field.decodeField(null)
    }
    return out
  }

  /** Encodes supplied fields for insertion without comparing stored values. */
  encodeAll(values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(values)) {
      Object.assign(out, this.#encodeOne(name, value))
    }
    return out
  }

  /**
   * Returns encoded columns whose values differ from storage. Omitting unchanged fields
   * prevents new stamps from overwriting concurrent edits.
   */
  encodeChanged(
    next: Record<string, unknown>,
    stored: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [column, value] of Object.entries(this.encodeAll(next))) {
      if (same(stored[column], value)) continue
      out[column] = value
    }
    return out
  }

  #encodeOne(name: string, value: unknown): Record<string, unknown> {
    const field = this.fieldByName(name)
    if (field === undefined) {
      throw new Error(`migration: '${this.name}.${name}' is not live`)
    }
    if (field.kind !== 'derived') {
      return this.#encodeStored(field, value)
    }
    if (!field.writable) {
      throw new Error(`migration: '${this.name}.${name}' is derived and has no split`)
    }

    // Write edits to source columns so peers without the derived field receive the edits.
    const [a, b] = field.split!(value)
    const [left, right] = field.derivedFrom!
    return {
      [this.fieldsById.get(left)!.column]: a,
      [this.fieldsById.get(right)!.column]: b,
    }
  }

  /**
   * Encodes a stored field and its superseded slots through `encodeToOld`. Peers that
   * know only a superseded field can read and insert rows using the superseded slot.
   */
  #encodeStored(field: FieldEntry, value: unknown): Record<string, unknown> {
    // Store absent optional values as SQL NULL to match `decodeField`.
    const out: Record<string, unknown> = { [field.column]: field.encodeField(value) ?? null }
    if (field.fallbackEncode === undefined || field.supersedes === undefined) return out
    const oldValue = field.fallbackEncode(value)
    for (const id of field.supersedes) {
      Object.assign(out, this.#encodeStored(this.fieldsById.get(id)!, oldValue))
    }
    return out
  }

  #valueOf(row: Record<string, unknown>, id: FieldId): unknown {
    const field = this.fieldsById.get(id)
    return field === undefined ? undefined : row[field.column]
  }

  #unwrittenValue(field: FieldEntry): unknown {
    if (field.fallbackDecode === undefined || field.acceptsAbsent()) return null
    return field.columnDefault ?? null
  }

  /** Decodes the first populated superseded slot through `decodeFromOld`. */
  #supersededValue(row: Record<string, unknown>, field: FieldEntry): unknown {
    if (field.fallbackDecode === undefined || field.supersedes === undefined) return undefined
    for (const old of field.supersedes) {
      const previous = this.#valueOf(row, old)
      if (previous !== undefined && previous !== null) return field.fallbackDecode(previous)
    }
    return undefined
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
