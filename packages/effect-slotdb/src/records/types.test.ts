import { describe, it, expect } from '@effect/vitest'
import { FIXTURE_INDEX } from '../testing.ts'
import type { RowOf, InsertOf, PatchOf, PutOf, KeyOf, WhereOf } from './types.ts'
import type { EntityEntry } from '../migration'
import type { StructFieldsOf } from '../migration/operations.ts'
import type { IsLocal } from '../migration/fields.ts'

type NotesEntity = typeof FIXTURE_INDEX.typed.notes
type PeersEntity = typeof FIXTURE_INDEX.typed.peers
type ReadingsEntity = typeof FIXTURE_INDEX.typed.readings

// Entity entries returned by `typed` must have the field types declared by the chain.
type TypedFieldsOf<E> = E extends EntityEntry<infer F> ? F : never
const _typedNotes: StructFieldsOf<typeof FIXTURE_INDEX.schemas.notes> = {} as TypedFieldsOf<
  typeof FIXTURE_INDEX.typed.notes
>
const _typedReadings: StructFieldsOf<typeof FIXTURE_INDEX.schemas.readings> = {} as TypedFieldsOf<
  typeof FIXTURE_INDEX.typed.readings
>

// Distinct entities must have distinct field types.
// Reject accidental resolution to never or any.
// @ts-expect-error notes declares no `noteId`
const _notVacuous: StructFieldsOf<typeof FIXTURE_INDEX.schemas.readings> = {} as TypedFieldsOf<
  typeof FIXTURE_INDEX.typed.notes
>

describe('marker extraction against the runtime index', () => {
  it('extracts the key fields the chain declares', () => {
    const notesEntity = FIXTURE_INDEX.entity('notes')
    const runtimeKeyNames = notesEntity.keyFields.map(f => f.currentName!).sort()
    expect(runtimeKeyNames).toEqual(['id'])

    type KeyNames = keyof KeyOf<NotesEntity>
    const _check: 'id' = {} as KeyNames

    const readingsEntity = FIXTURE_INDEX.entity('readings')
    const runtimeReadingKeys = readingsEntity.keyFields.map(f => f.currentName!).sort()
    expect(runtimeReadingKeys).toEqual(['noteId', 'readerId'])

    type ReadingKeyNames = keyof KeyOf<ReadingsEntity>
    const _readingCheck: 'noteId' | 'readerId' = {} as ReadingKeyNames
  })

  it('excludes the tombstone from the row type, and keeps the other framework fields', () => {
    const notesEntity = FIXTURE_INDEX.entity('notes')
    const runtimeFramework = notesEntity.frameworkFields.map(f => f.currentName!).sort()
    expect(runtimeFramework).toEqual(['createdAt', 'deletedAt'])
    expect(notesEntity.tombstoneField?.currentName).toBe('deletedAt')
    expect(notesEntity.createdField?.currentName).toBe('createdAt')

    type Row = RowOf<NotesEntity>
    const _noDeletedAt: 'deletedAt' = {} as 'deletedAt' extends keyof Row ? never : 'deletedAt'
    // Creation time is written by the framework and included in row reads.
    const _hasCreatedAt: unknown = {} as Row['createdAt']
  })

  it('excludes every framework field from the write shapes', () => {
    type Insert = InsertOf<NotesEntity>
    const _noCreatedOnInsert: 'createdAt' = {} as 'createdAt' extends keyof Insert
      ? never
      : 'createdAt'
    const _noDeletedOnInsert: 'deletedAt' = {} as 'deletedAt' extends keyof Insert
      ? never
      : 'deletedAt'

    type Patch = PatchOf<NotesEntity>
    const _noCreatedOnPatch: 'createdAt' = {} as 'createdAt' extends keyof Patch
      ? never
      : 'createdAt'
    const _noDeletedOnPatch: 'deletedAt' = {} as 'deletedAt' extends keyof Patch
      ? never
      : 'deletedAt'
  })

  it('extracts the local fields the chain declares', () => {
    const notesEntity = FIXTURE_INDEX.entity('notes')
    const runtimeLocal = [...notesEntity.fieldsById.values()]
      .filter(f => f.local)
      .map(f => f.currentName!)
      .sort()
    expect(runtimeLocal).toEqual(['lastEditedAt', 'openedAt'])

    type Row = RowOf<NotesEntity>
    const _openedAt: unknown = {} as Row['openedAt']
    const _lastEditedAt: unknown = {} as Row['lastEditedAt']
  })

  it('extracts the defaulted fields the chain declares', () => {
    const notesEntity = FIXTURE_INDEX.entity('notes')
    const runtimeDefaulted = [...notesEntity.fieldsById.values()]
      .filter(f => f.columnDefault !== undefined)
      .map(f => f.currentName!)
      .sort()
    expect(runtimeDefaulted).toEqual(['archived', 'createdAt', 'kind', 'pinned'])

    type Insert = InsertOf<NotesEntity>
    const _hasId: string = {} as Insert['id']
    const _hasTitle: string = {} as Insert['title']
    type InsertKeys = keyof Insert
    const _noKind: 'kind' = {} as 'kind' extends InsertKeys ? never : 'kind'
  })

  it('extracts the immutable fields the chain declares', () => {
    const notesEntity = FIXTURE_INDEX.entity('notes')
    const runtimeImmutable = [...notesEntity.fieldsById.values()]
      .filter(f => f.policy === 'fww')
      .map(f => f.currentName!)
      .sort()
    expect(runtimeImmutable).toEqual(['id'])

    type Patch = PatchOf<NotesEntity>
    type PatchKeys = keyof Patch
    const _noId: 'id' = {} as 'id' extends PatchKeys ? never : 'id'
  })
})

describe('the marker remains after a wrapping operation', () => {
  it('a local field arriving through addOptional keeps the local marker', () => {
    type _Fields = StructFieldsOf<(typeof FIXTURE_INDEX)['schemas']['notes']>
    const _isLocal: true = {} as IsLocal<_Fields['lastEditedAt']>
  })
})

describe('PatchOf refuses key, immutable, and framework fields', () => {
  it('a key field does not compile in a patch', () => {
    type Patch = PatchOf<NotesEntity>
    type PatchKeys = keyof Patch
    const _noId: 'id' = {} as 'id' extends PatchKeys ? never : 'id'

    // @ts-expect-error a key field cannot be patched
    const _bad: Patch = { id: 'n1' }
    void _bad
  })

  it('a composite key field does not compile in a patch', () => {
    type ReadingPatch = PatchOf<ReadingsEntity>
    type PatchKeys = keyof ReadingPatch
    const _noNoteId: 'noteId' = {} as 'noteId' extends PatchKeys ? never : 'noteId'

    // @ts-expect-error a key field cannot be patched
    const _bad: ReadingPatch = { noteId: 'n1' }
    void _bad
  })

  it('a framework field does not compile in a patch', () => {
    type Patch = PatchOf<NotesEntity>
    type PatchKeys = keyof Patch
    const _noDeletedAt: 'deletedAt' = {} as 'deletedAt' extends PatchKeys ? never : 'deletedAt'
    const _noCreatedAt: 'createdAt' = {} as 'createdAt' extends PatchKeys ? never : 'createdAt'

    // @ts-expect-error a framework field cannot be patched
    const _bad: Patch = { deletedAt: null }
    void _bad
  })

  it('a writable field does compile in a patch', () => {
    type Patch = PatchOf<NotesEntity>
    const _good: Patch = { title: 'updated' }
  })
})

describe('InsertOf omits defaulted, optional, and nullable fields', () => {
  it('a defaulted field is not required on an insert', () => {
    type Insert = InsertOf<NotesEntity>
    type InsertKeys = keyof Insert
    const _noKind: 'kind' = {} as 'kind' extends InsertKeys ? never : 'kind'

    const _good: Insert = { id: 'n1', title: 'title' }
  })

  it('a nullable field is not required on an insert', () => {
    type Insert = InsertOf<NotesEntity>
    type InsertKeys = keyof Insert
    // Nullable tags and openedAt fields may be omitted on insertion.
    const _noTags: 'tags' = {} as 'tags' extends InsertKeys ? never : 'tags'
    const _noOpenedAt: 'openedAt' = {} as 'openedAt' extends InsertKeys ? never : 'openedAt'
  })

  it('a nullable field may be provided on an insert', () => {
    type Insert = InsertOf<NotesEntity>
    // A nullable field is optional instead of excluded. The caller may provide it.
    const _good: Insert = { id: 'n1', title: 'title', tags: 'work' }
  })

  it('a key field is required on an insert', () => {
    type Insert = InsertOf<NotesEntity>
    const _hasId: string = {} as Insert['id']
  })

  it('omitting a required field does not compile', () => {
    type Insert = InsertOf<NotesEntity>
    // @ts-expect-error title is required (not defaulted, not optional, not nullable)
    const _bad: Insert = { id: 'n1' }
    void _bad
  })
})

describe('PutOf requires keys and allows any non-framework field', () => {
  it('keys are required on a put', () => {
    type Put = PutOf<NotesEntity>
    const _hasId: string = {} as Put['id']
  })

  it('a defaulted field is optional on a put', () => {
    type Put = PutOf<NotesEntity>
    const _good: Put = { id: 'n1', kind: 'plain' }
  })

  it('a nullable field is optional on a put', () => {
    type Put = PutOf<NotesEntity>
    const _good: Put = { id: 'n1', tags: 'work' }
  })

  it('an immutable field is optional on a put', () => {
    type Put = PutOf<ReadingsEntity>
    // PutOf requires the immutable noteId and readerId key fields.
    const _hasNoteId: string = {} as Put['noteId']
  })

  it('a framework field does not compile in a put', () => {
    type Put = PutOf<NotesEntity>
    // @ts-expect-error the creation time is framework-owned
    const _bad: Put = { id: 'n1', createdAt: null }
    void _bad
  })

  it('omitting the key does not compile', () => {
    type Put = PutOf<NotesEntity>
    // @ts-expect-error id is a key and is required
    const _bad: Put = { title: 't' }
    void _bad
  })
})

describe('the peers entity exercises nullable, local, and immutable together', () => {
  it('RowOf excludes the tombstone and includes the remaining fields', () => {
    type Row = RowOf<PeersEntity>
    const _peerId: string = {} as Row['peerId']
    const _accountId: string = {} as Row['accountId']
    const _registeredAt: unknown = {} as Row['registeredAt']
    const _label: string | null = {} as Row['label']
    const _lastSeenAt: unknown = {} as Row['lastSeenAt']
    // The tombstone is excluded.
    const _noDeletedAt: 'deletedAt' = {} as 'deletedAt' extends keyof Row ? never : 'deletedAt'
  })

  it('KeyOf includes both key fields', () => {
    type Keys = KeyOf<PeersEntity>
    type KeyNames = keyof Keys
    const _peerId: string = {} as KeyNames
    const _accountId: string = {} as KeyNames
    const _noLabel: 'label' = {} as 'label' extends KeyNames ? never : 'label'
  })

  it('InsertOf requires keys, omits nullable and defaulted fields', () => {
    type Insert = InsertOf<PeersEntity>
    type InsertKeys = keyof Insert
    const _hasPeerId: string = {} as Insert['peerId']
    const _hasAccountId: string = {} as Insert['accountId']
    // label, lastSeenAt, chainPosition, pulledThrough are all nullable, so optional.
    const _noLabel: 'label' = {} as 'label' extends InsertKeys ? never : 'label'
    const _noLastSeenAt: 'lastSeenAt' = {} as 'lastSeenAt' extends InsertKeys ? never : 'lastSeenAt'
  })

  it('PutOf requires keys, allows all non-framework fields optionally', () => {
    type Put = PutOf<PeersEntity>
    const _hasPeerId: string = {} as Put['peerId']
    const _hasAccountId: string = {} as Put['accountId']
    // registeredAt is immutable but settable on the insert path of a put.
    const _good: Put = { peerId: 'laptop', accountId: 'acct', registeredAt: {} as never }
  })

  it('PatchOf refuses keys and the immutable registeredAt', () => {
    type Patch = PatchOf<PeersEntity>
    type PatchKeys = keyof Patch
    const _noPeerId: 'peerId' = {} as 'peerId' extends PatchKeys ? never : 'peerId'
    const _noAccountId: 'accountId' = {} as 'accountId' extends PatchKeys ? never : 'accountId'
    // registeredAt is identity (immutable), so it cannot be patched.
    const _noRegisteredAt: 'registeredAt' = {} as 'registeredAt' extends PatchKeys
      ? never
      : 'registeredAt'
    // label is nullable but not immutable, so it can be patched.
    const _hasLabel: 'label' = {} as 'label' extends PatchKeys ? 'label' : never
  })
})

describe('RowOf and KeyOf', () => {
  it('RowOf includes decoded field types', () => {
    type Row = RowOf<NotesEntity>
    const _id: string = {} as Row['id']
    const _title: string = {} as Row['title']
    const _tags: string | null = {} as Row['tags']
  })

  it('KeyOf includes encoded key types', () => {
    type Keys = KeyOf<ReadingsEntity>
    const _noteId: string = {} as Keys['noteId']
    const _readerId: string = {} as Keys['readerId']
  })

  it('WhereOf takes an encoded value to match, or a comparison over it', () => {
    const byValue: WhereOf<NotesEntity> = { id: 'note-1' }
    const byRange: WhereOf<NotesEntity> = { id: { gte: 'note-1', lt: 'note-9' } }
    const bySet: WhereOf<NotesEntity> = { id: { in: ['note-1', 'note-2'] } }
    expect([byValue, byRange, bySet]).toHaveLength(3)

    // @ts-expect-error the value is the encoded one, so a number is not a note id
    const _wrongType: WhereOf<NotesEntity> = { id: 1 }
    // @ts-expect-error the vocabulary stops at equality, set membership, and range
    const _unsupported: WhereOf<NotesEntity> = { id: { like: 'note-%' } }
  })
})
