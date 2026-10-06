import * as SchemaAST from 'effect/SchemaAST'
import { EntityId, FieldId } from './ids.ts'
import { canonicalizeAst } from './operations.ts'
import { widensOpenUnions } from './open-literals.ts'
import { Migration } from './migration.ts'
import { FieldEntry } from './entries.ts'
import { SchemaIndex } from './schema-index.ts'

/** A problem in a migration chain or its committed identity lockfile. */
export interface Diagnostic {
  readonly code:
    | 'draft-rename'
    | 'value-drift'
    | 'read-only-derived'
    | 'vanished-field'
    | 'missing-lockfile'
    | 'stale-lockfile'
    | 'unrecorded-field'
  readonly message: string
}

/**
 * Recorded field fingerprints indexed by entity ID and field ID.
 */
export type LockSnapshot = ReadonlyMap<EntityId, ReadonlyMap<FieldId, string>>

// Entity records include `table=`. Field records include fingerprints and notes.
const ENTITY_LINE = /^([^\t]+)\tentity [^\t]+\ttable=/
const FIELD_LINE = /^([^\t]+)\t([^\t]*)\t\(/

/**
 * Parses recorded field fingerprints and skips unrecognized lines.
 * @internal
 */
export const parseLockfile = (text: string): LockSnapshot => {
  const out = new Map<EntityId, Map<FieldId, string>>()
  let current: Map<FieldId, string> | undefined

  for (const line of text.split('\n')) {
    const entity = ENTITY_LINE.exec(line)
    if (entity !== null) {
      current = new Map()
      out.set(EntityId.make(entity[1]), current)
      continue
    }
    const field = FIELD_LINE.exec(line)
    if (field !== null && current !== undefined) current.set(FieldId.make(field[1]), field[2])
  }

  return out
}

/**
 * Reports changed fingerprints and missing IDs compared with the committed lockfile.
 * @internal
 */
export const checkDrift = (
  previous: LockSnapshot,
  index: SchemaIndex,
): ReadonlyArray<Diagnostic> => {
  const diagnostics: Diagnostic[] = []

  for (const [entityId, fields] of previous) {
    const entity = index.entities.get(entityId)

    for (const [fieldId, fingerprint] of fields) {
      const entry = entity?.fieldsById.get(fieldId)

      if (entry === undefined) {
        diagnostics.push({
          code: 'vanished-field',
          message:
            `Field ${fieldId} is recorded in the lockfile but absent from the chain. ` +
            `Removing a field must retain its retired ID. Restore the applied migration ` +
            `so peers can continue to address that ID.`,
        })
        continue
      }

      if (entry.fingerprint !== fingerprint && !widensOpenUnions(fingerprint, entry.fingerprint)) {
        diagnostics.push({
          code: 'value-drift',
          message:
            `Field ${fieldId} ('${entry.birthName}' in ${entry.entity}) has a different stored type ` +
            `or merge policy under the same ID. Peers would interpret the same slot differently. ` +
            `Declare a retype to assign a new ID and retain the retired slot.`,
        })
      }
    }
  }

  return diagnostics
}

/**
 * Checks a chain without comparing a committed lockfile.
 * @internal
 */
export const checkChain = (chain: readonly Migration[]): ReadonlyArray<Diagnostic> => [
  ...draftRenames(chain),
  ...readOnlyDerived(new SchemaIndex(chain)),
]

/**
 * Checks a chain and its committed lockfile using the rules shared by regeneration and
 * tests. Omit `committed` before a lockfile exists. An empty result means the checks
 * pass.
 */
export const checkLockfile = (
  index: SchemaIndex,
  committed?: string,
): ReadonlyArray<Diagnostic> => {
  const chainProblems = checkChain(index.chain)
  if (committed === undefined) {
    return [
      ...chainProblems,
      {
        code: 'missing-lockfile',
        message:
          'No lockfile is committed for this chain. Generate and commit a lockfile to record ' +
          'field identities and detect incompatible changes.',
      },
    ]
  }

  const previous = parseLockfile(committed)
  return [
    ...chainProblems,
    ...checkDrift(previous, index),
    ...unrecordedFields(previous, index),
    ...(committed === `${index.lockfile()}\n`
      ? []
      : [
          {
            code: 'stale-lockfile' as const,
            message:
              'The committed lockfile differs from the chain. Regenerate the lockfile and review ' +
              'changes to IDs, columns, and fingerprints.',
          },
        ]),
  ]
}

/**
 * Checks whether regeneration would overwrite a field identity conflict.
 * Missing, stale, or incomplete lockfiles can be regenerated.
 */
export const blocksRegeneration = (problem: Diagnostic): boolean =>
  problem.code !== 'missing-lockfile' &&
  problem.code !== 'stale-lockfile' &&
  problem.code !== 'unrecorded-field'

/** Reports field fingerprints absent from the lockfile, including retired fields. */
const unrecordedFields = (
  previous: LockSnapshot,
  index: SchemaIndex,
): ReadonlyArray<Diagnostic> => {
  const diagnostics: Diagnostic[] = []

  for (const entity of index.entities.values()) {
    for (const field of entity.fieldsById.values()) {
      if (previous.get(entity.id)?.get(field.id) === field.fingerprint) continue
      diagnostics.push({
        code: 'unrecorded-field',
        message:
          `Field ${field.id} ('${field.birthName}' in ${entity.table}) has no matching fingerprint ` +
          `in the lockfile. Regenerate the lockfile after resolving identity conflicts.`,
      })
    }
  }

  return diagnostics
}

const ABSENT_TAGS = new Set(['Undefined', 'Null'])

/**
 * Returns a stored type fingerprint without null or undefined alternatives. Allows
 * required and optional fields of the same stored type to be compared.
 */
const comparableType = (field: FieldEntry): string => {
  const encoded = SchemaAST.toEncoded(field.schema.ast) as any
  if (!Array.isArray(encoded.types)) return canonicalizeAst(encoded)

  const present = encoded.types.filter((t: any) => !ABSENT_TAGS.has(String(t._tag)))
  return canonicalizeAst(present.length === 1 ? present[0] : { ...encoded, types: present })
}

/**
 * Reports a removed field and a new field of the same stored type in one migration.
 * Excludes fields that declare `supersedes` through retype or promotion.
 */
const draftRenames = (chain: readonly Migration[]): ReadonlyArray<Diagnostic> => {
  const diagnostics: Diagnostic[] = []

  for (let i = 0; i < chain.length; i++) {
    const before = new SchemaIndex(chain.slice(0, i))
    const after = new SchemaIndex(chain.slice(0, i + 1))
    const file = chain[i].file

    for (const entity of after.entities.values()) {
      const previous = before.entities.get(entity.id)
      if (previous === undefined) continue

      const liveBefore = new Set(previous.liveFieldIds.values())
      const liveAfter = new Set(entity.liveFieldIds.values())

      // Merge sources leave the schema but remain replicated, so check the retired set.
      const retired = [...liveBefore].filter(
        id => !liveAfter.has(id) && entity.retiredFields.has(id),
      )

      // Select new fields without a declared superseded field.
      const born = [...liveAfter]
        .filter(id => !liveBefore.has(id))
        .map(id => entity.fieldsById.get(id)!)
        .filter(f => f.supersedes === undefined)

      for (const goneId of retired) {
        const gone = entity.fieldsById.get(goneId)!
        for (const fresh of born) {
          if (comparableType(fresh) !== comparableType(gone)) continue
          diagnostics.push({
            code: 'draft-rename',
            message:
              `${file}: '${gone.birthName}' is removed and '${fresh.birthName}' added with the same ` +
              `stored type. For a rename, use \`rename\` to preserve the field ID. ` +
              `For unrelated fields, use separate migration files to distinguish the operations.`,
          })
        }
      }
    }
  }

  return diagnostics
}

/**
 * Reports derived fields without `split`. These fields can be read but cannot be written.
 */
const readOnlyDerived = (index: SchemaIndex): ReadonlyArray<Diagnostic> => {
  const diagnostics: Diagnostic[] = []

  for (const entity of index.entities.values()) {
    for (const field of entity.fieldsById.values()) {
      if (field.kind !== 'derived' || field.writable) continue
      diagnostics.push({
        code: 'read-only-derived',
        message: `'${field.birthName}' in ${entity.table} is derived from ${field.derivedFrom?.join(
          ' and ',
        )} but declares no split. Add a split function to write edits to the source fields.`,
      })
    }
  }

  return diagnostics
}
