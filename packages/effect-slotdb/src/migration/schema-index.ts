import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import { annotationsOf } from './annotations.ts'
import { type EntityId, type FieldId } from './ids.ts'
import { entityIdOf, fieldIdOf } from './ids.ts'
import { canonicalizeAst, fieldsOf, type StructFieldsOf } from './operations.ts'
import { EntityEntry, FieldEntry } from './entries.ts'
import { openMembersIn } from './open-literals.ts'
import type { EntityName, Migration, NoExtraProperties } from './migration.ts'

type AnyFields = Schema.Struct.Fields
type AnySchema = Schema.Top

export class SchemaIndex<const C extends readonly Migration[] = readonly Migration[]> {
  readonly #byTable = new Map<string, EntityEntry>()

  readonly entities: ReadonlyMap<EntityId, EntityEntry>
  readonly byName: ReadonlyMap<EntityName, EntityEntry>
  readonly schemas: DeclaredSchemas<C>
  readonly typed: TypedEntities<C>

  constructor(readonly chain: C) {
    const { entities, byName } = deriveIndex(chain)
    this.entities = entities
    this.byName = byName

    const schemas: Record<string, Schema.Top> = {}
    const typed: Record<string, EntityEntry> = {}
    for (const [name, entry] of this.byName) {
      schemas[name] = entry.schema
      typed[name] = entry
      this.#byTable.set(entry.table, entry)
    }
    this.schemas = schemas as DeclaredSchemas<C>
    this.typed = typed as TypedEntities<C>
  }

  static seed<const M extends Migration>(migration: M & NoExtraProperties<M>) {
    return new SchemaIndex([migration as M])
  }

  /**
   * Appends a migration and returns the updated chain and entity schemas.
   */
  appendMigration<const M extends Migration>(migration: M & NoExtraProperties<M>) {
    const appended = [...this.chain, migration] as unknown as readonly [...C, M]
    return new SchemaIndex(appended)
  }

  /**
   * Returns the entity for a current name. Throws when the chain has no matching entity.
   */
  entity(name: EntityName): EntityEntry {
    const entry = this.byName.get(name)
    if (entry === undefined) throw new Error(`migration: unknown entity '${name}'`)
    return entry
  }

  /** Returns the entity for a storage table. Throws when no entity declares the table. */
  entityForTable(table: string): EntityEntry {
    const entry = this.#byTable.get(table)
    if (entry === undefined) throw new Error(`migration: no entity declares table '${table}'`)
    return entry
  }

  /** Renders the identity lockfile for reviewing IDs, columns, and fingerprints. */
  lockfile(): string {
    const lines: string[] = []

    const entities = [...this.entities.values()].sort((a, b) =>
      a.birthName < b.birthName ? -1 : 1,
    )

    for (const entity of entities) {
      lines.push(`\n${entity.id}\tentity ${entity.birthName}\ttable=${entity.table}`)

      const fields = [...entity.fieldsById.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
      for (const f of fields) {
        const notes = [`born ${f.bornIn} as "${f.birthName}"`, `column=${f.column}`, f.policy]
        if (f.currentName !== undefined && f.currentName !== f.birthName) {
          notes.push(`renamed -> ${f.currentName}`)
        }
        if (f.kind === 'derived') notes.push(`derived from ${f.derivedFrom?.join('+')}`)
        if (f.supersedes !== undefined) notes.push(`supersedes ${f.supersedes.join('+')}`)
        if (f.keyPosition !== undefined) notes.push(`key=${f.keyPosition}`)
        if (f.local) notes.push('local')
        if (f.framework !== undefined) notes.push(`framework:${f.framework}`)
        if (entity.retiredFields.has(f.id)) notes.push('retired')
        if (entity.syncedSources.has(f.id)) notes.push('synced source')
        lines.push(`${f.id}\t${f.fingerprint}\t(${notes.join(', ')})`)
      }
    }

    return lines.join('\n')
  }

  /** The last migration file in the chain, reported to other peers as schema progress. */
  lastMigrationFile() {
    return this.chain[this.chain.length - 1].file
  }
}

/**
 * Derives field identities, columns, and codecs from a migration chain. Peers with a
 * shared chain prefix derive the same IDs for fields in that prefix.
 */
export const deriveIndex = (chain: readonly Migration[]) => {
  const states = new Map<EntityName, EntityState>()

  for (const migration of chain) {
    for (const [from, to] of Object.entries(migration.renameEntity ?? {})) {
      const state = states.get(from)
      if (state === undefined) {
        throw new Error(`migration: rename of unknown entity '${from}'`)
      }
      states.delete(from)
      states.set(to, state)
    }

    for (const [name, ops] of Object.entries(migration.entities ?? {})) {
      let state = states.get(name)
      if (state === undefined) {
        state = { birthName: name, schema: structFrom({}), claimed: new Set(), born: new Map() }
        states.set(name, state)
      }

      // Assign IDs after each operation for subsequent operations to read.
      let schema = state.schema
      for (const op of ops.operations) {
        schema = sweep(state, op(schema), migration.file)
      }
      state.schema = schema
    }
  }

  const entities = new Map<EntityId, EntityEntry>()
  const byName = new Map<EntityName, EntityEntry>()

  for (const [currentName, state] of states) {
    const entityId = entityIdOf(state.birthName)
    const liveFieldIds = new Map<string, FieldId>()
    const liveFieldNames = new Map<FieldId, string>()
    const syncedSources = new Set<FieldId>()

    for (const [fieldName, fieldSchema] of Object.entries(fieldsOf(state.schema))) {
      const a = annotationsOf(fieldSchema as AnySchema)
      liveFieldIds.set(fieldName, a.fieldId!)
      liveFieldNames.set(a.fieldId!, fieldName)
      for (const src of a.derivedFrom ?? []) {
        syncedSources.add(src)
      }
    }

    // Retain retired columns and codecs to relay values and read retype fallbacks.
    const fieldsById = new Map<FieldId, FieldEntry>()
    const retiredFields = new Set<FieldId>()

    for (const [fieldId, born] of state.born) {
      const currentFieldName = liveFieldNames.get(fieldId)
      const schema = born.schema
      const a = annotationsOf(schema)
      const policy = a.merge ?? 'lww'
      const kind = a.derivedFrom === undefined ? 'stored' : 'derived'
      const typeFingerprint = typeFingerprintOf(schema)

      const fieldEntry = new FieldEntry({
        id: fieldId,
        entity: entityId,
        birthName: born.birthName,
        bornIn: born.bornIn,
        column: born.column,
        currentName: currentFieldName,
        kind,
        policy,
        keyPosition: a.key,
        uniquePosition: a.unique,
        local: a.local === true,
        columnDefault: a.columnDefault,
        materialize: a.materialize === true,
        framework: a.framework,
        writable: kind === 'stored' ? true : a.writable === true,
        derivedFrom: a.derivedFrom,
        supersedes: a.supersedes,
        fallbackDecode: a.fallbackDecode,
        fallbackEncode: a.fallbackEncode,
        combine: a.combine,
        split: a.split,
        openMembers: openMembersIn(SchemaAST.toEncoded(schema.ast)),
        typeFingerprint,
        fingerprint: `${typeFingerprint}|${policy}${a.key != null ? `|key=${a.key}` : ''}${a.local === true ? '|local' : ''}${a.framework !== undefined ? `|framework=${a.framework}` : ''}`,
        schema,
      })

      fieldsById.set(fieldId, fieldEntry)

      // Fields referenced by live projections remain replicated sources.
      // Other removed fields are retired and relayed without application reads.
      if (currentFieldName === undefined && !syncedSources.has(fieldId)) {
        retiredFields.add(fieldId)
      }
    }

    const entry = new EntityEntry({
      id: entityId,
      birthName: state.birthName,
      name: currentName,
      table: state.birthName,
      schema: state.schema,
      liveFieldIds,
      fieldsById,
      retiredFields,
      syncedSources,
    })
    entities.set(entityId, entry)
    byName.set(currentName, entry)
  }

  return { entities, byName }
}

/** The stored schema and identity retained after a field leaves the current shape. */
interface Born {
  readonly birthName: string
  readonly bornIn: string
  readonly column: string
  /** The schema used to decode the retired column. */
  schema: AnySchema
}

interface EntityState {
  readonly birthName: string
  schema: AnySchema
  /** Assigned column names, including retired columns. Names remain reserved. */
  readonly claimed: Set<string>
  readonly born: Map<FieldId, Born>
}

const COLUMN_SUFFIX_LEN = 8

const structFrom = (fields: AnyFields): AnySchema =>
  Schema.Struct(fields as Parameters<typeof Schema.Struct>[0]) as AnySchema

/**
 * Assigns IDs and columns to fields without IDs while preserving existing field schemas.
 * Preserving schema objects retains annotations and storage codecs.
 */
const sweep = (state: EntityState, schema: AnySchema, file: string): AnySchema => {
  const next: Record<string, AnySchema> = {}

  for (const [name, raw] of Object.entries(fieldsOf(schema))) {
    const fieldSchema = raw as AnySchema
    const annotations = annotationsOf(fieldSchema)
    const existing = annotations.fieldId

    if (existing !== undefined) {
      next[name] = fieldSchema
      const born = state.born.get(existing)
      // Retain the latest field schema so retired values use the current storage codec.
      if (born !== undefined) born.schema = fieldSchema
      continue
    }

    const id = fieldIdOf(name, file)
    if (state.born.has(id)) {
      throw new Error(`migration: ID collision for '${state.birthName}.${name}' in ${file}`)
    }

    // Resolve column name conflicts with an ID suffix.
    // Chain order makes names consistent across shared prefixes.
    const plain = annotations.column ?? name
    const column = state.claimed.has(plain) ? `${plain}_${id.slice(0, COLUMN_SUFFIX_LEN)}` : plain
    if (state.claimed.has(column)) {
      throw new Error(`migration: column collision '${column}' in ${state.birthName}`)
    }

    const stamped = (fieldSchema as any).annotate({ fieldId: id })
    state.claimed.add(column)
    state.born.set(id, { birthName: name, bornIn: file, column, schema: stamped })
    next[name] = stamped
  }

  return structFrom(next as AnyFields)
}

const typeFingerprintOf = (schema: AnySchema): string =>
  canonicalizeAst(SchemaAST.toEncoded(schema.ast))

/**
 * Renames entity keys while preserving their field types. Keeps the old key when the
 * target is widened to `string` to avoid an unrestricted index signature.
 */
type WithRenames<Acc, M> = M extends { readonly renameEntity: infer R }
  ? {
      [
        K in keyof Acc as K extends keyof R
          ? string extends Extract<R[K], string>
            ? K
            : Extract<R[K], string>
          : K
      ]: Acc[K]
    }
  : Acc

/**
 * Replaces schemas for entities declared in a file and preserves other entries.
 */
type WithDeclarations<Acc, M> = M extends { readonly entities: infer E }
  ? Omit<Acc, keyof E> & {
      [K in keyof E]: E[K] extends { readonly schema: infer S } ? S : AnySchema
    }
  : Acc

/** The entity schemas derived by applying declarations and renames in chain order. */
type DeclaredSchemas<C extends readonly unknown[], Acc = object> = C extends readonly [
  infer Head,
  ...infer Rest,
]
  ? DeclaredSchemas<Rest, WithDeclarations<WithRenames<Acc, Head>, Head>>
  : { readonly [K in keyof Acc]: Acc[K] }

/**
 * Entity entries with declared field types for row, key, insert, and patch operations.
 */
type TypedEntities<C extends readonly unknown[]> = {
  readonly [K in keyof DeclaredSchemas<C> & string]: EntityEntry<
    StructFieldsOf<DeclaredSchemas<C>[K]>
  >
}

/**
 * Derives schemas with annotated field IDs from a chain prefix. Use to seed operations
 * that require existing IDs.
 * @internal
 */
export const shapeOf = <const C extends readonly Migration[], E extends keyof DeclaredSchemas<C>>(
  chain: C,
  entity: E,
): DeclaredSchemas<C>[E] => {
  const entry = deriveIndex(chain).byName.get(entity as string)
  if (entry === undefined) throw new Error(`migration: unknown entity '${String(entity)}'`)
  return entry.schema as DeclaredSchemas<C>[E]
}
