import { describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import { addOptional, migrateSchema, mergeFields, remove, retype, seed } from './operations.ts'
import { shapeOf, SchemaIndex } from './schema-index.ts'
import { FIXTURE_INDEX } from '../testing.ts'
import { key, unique } from './fields.ts'
import { Migration } from './migration.ts'

describe('reading through the index', () => {
  const notes = FIXTURE_INDEX.entity('notes')

  it('returns the columns declared by the chain', () => {
    // Derive column names from the chain so added fields appear in reads.
    expect(notes.selectColumns).toEqual([
      'archived',
      'createdAt',
      'deletedAt',
      'id',
      'kind',
      'lastEditedAt',
      'openedAt',
      'pinned',
      'summary',
      'tags',
      'title',
    ])
  })

  it('decodes each column through its own codec', () => {
    const decoded = notes.decode({ id: 'n1', title: 'Deep work', kind: 'plain', archived: 0 })

    expect(decoded.title).toBe('Deep work')
    // A bit-encoded boolean arrives as an integer and decodes to a boolean.
    expect(decoded.archived).toBe(false)
  })

  it('omits a field whose column holds nothing', () => {
    expect(Object.keys(notes.decode({ title: 'Deep work' }))).toEqual(['title'])
  })
})

describe('writing through the index', () => {
  const notes = FIXTURE_INDEX.entity('notes')

  it('encodes to column values', () => {
    expect(notes.encodeAll({ title: 'Deep work' })).toEqual({ title: 'Deep work' })
  })

  it('writes only what changed', () => {
    const stored = { title: 'Deep work', archived: 0 }
    const changed = notes.encodeChanged({ title: 'Deep work', archived: true }, stored)

    // `title` is unchanged, so it is not written and therefore not restamped.
    expect(changed).toEqual({ archived: 1 })
  })

  it('writes nothing when nothing changed', () => {
    expect(notes.encodeChanged({ title: 'Deep work' }, { title: 'Deep work' })).toEqual({})
  })

  it('encoding includes unchanged fields while diffing omits them', () => {
    // Rewriting unchanged fields would assign new stamps that overwrite concurrent edits.
    // Compare encoding with diffing to verify that unchanged fields are omitted.
    const stored = { title: 'Deep work' }

    expect(notes.encodeAll({ title: 'Deep work' })).toEqual({ title: 'Deep work' })
    expect(notes.encodeChanged({ title: 'Deep work' }, stored)).toEqual({})
  })
})

describe('derived fields', () => {
  const born = {
    file: '0000',
    entities: {
      person: seed(Schema.Struct({ id: Schema.String, first: Schema.String, last: Schema.String })),
    },
  } satisfies Migration

  const stamped = shapeOf([born], 'person')

  const chain: readonly Migration[] = [
    born,
    {
      file: '0001',
      entities: {
        person: migrateSchema(
          stamped,
          mergeFields(['first', 'last'], 'full', Schema.String, {
            combine: (a, b) => `${a ?? ''} ${b ?? ''}`.trim(),
            split: (v: string) => {
              const at = String(v).indexOf(' ')
              return at === -1 ? [v, ''] : [String(v).slice(0, at), String(v).slice(at + 1)]
            },
          }),
        ),
      },
    },
  ]

  const person = new SchemaIndex(chain).entity('person')

  it('computes a derived field from its source columns on read', () => {
    const decoded = person.decode({ id: 'p1', first: 'Ada', last: 'Lovelace' })
    expect(decoded.full).toBe('Ada Lovelace')
    // Derived fields replace their sources in the application schema.
    expect(decoded.first).toBeUndefined()
  })

  it('leaves the derived field absent when both sources are absent', () => {
    expect(person.decode({ id: 'p1' }).full).toBeUndefined()
  })

  it('writes an edit through to the source columns', () => {
    expect(person.encodeAll({ full: 'Ada Lovelace' })).toEqual({
      first: 'Ada',
      last: 'Lovelace',
    })
  })

  it('refuses to write a derived field with no split', () => {
    const readOnly = new SchemaIndex([
      born,
      {
        file: '0001',
        entities: {
          person: migrateSchema(
            stamped,
            mergeFields(['first', 'last'], 'full', Schema.String, {
              combine: (a, b) => `${a} ${b}`,
            }),
          ),
        },
      },
    ]).entity('person')

    expect(() => readOnly.encodeAll({ full: 'Ada Lovelace' })).toThrow(/no split/)
  })
})

describe('superseded slots', () => {
  const born = {
    file: '0000',
    entities: { doc: seed(Schema.Struct({ id: Schema.String })) },
  } satisfies Migration

  const sized = {
    file: '0001',
    entities: { doc: migrateSchema(shapeOf([born], 'doc'), addOptional('size', Schema.String)) },
  } satisfies Migration

  const chain: readonly Migration[] = [
    born,
    sized,
    {
      file: '0002',
      entities: {
        doc: migrateSchema(
          shapeOf([born, sized], 'doc'),
          retype('size', Schema.Number, { decodeFromOld: s => Number(s) }),
        ),
      },
    },
  ]

  const doc = new SchemaIndex(chain).entity('doc')
  // Decode using the column result keys returned by the client.
  const [oldColumn, newColumn] = doc.selectColumns.filter(c => c.startsWith('size'))

  it('reads the retired slot while the new one is empty', () => {
    // Read the retired slot while the replacement slot is empty.
    const decoded = doc.decode({ id: 'd1', [oldColumn]: '7' })
    expect(decoded.size).toBe(7)
  })

  it('prefers the new slot once it holds a value', () => {
    const decoded = doc.decode({ id: 'd1', [oldColumn]: '7', [newColumn]: 9 })
    expect(decoded.size).toBe(9)
  })
})

describe('model fields', () => {
  const fields = FIXTURE_INDEX.entity('notes').modelFields()

  it('returns model value fields without structural fields', () => {
    // Build model fields from the chain to keep storage codecs consistent.
    expect(Object.keys(fields).sort()).toEqual([
      'archived',
      'kind',
      'pinned',
      'summary',
      'tags',
      'title',
    ])
  })

  it('omits the key, since a model supplies its own identity column', () => {
    expect(fields.id).toBeUndefined()
  })

  it('omits every framework field, none of which a caller hands over', () => {
    expect(fields.deletedAt).toBeUndefined()
    expect(fields.createdAt).toBeUndefined()
  })

  it('omits a local field, which belongs to the peer rather than the row', () => {
    expect(fields.openedAt).toBeUndefined()
  })

  it('includes each field with its storage codec', () => {
    // A bit-encoded boolean encodes to the integer the column holds.
    expect(Schema.encodeUnknownSync(fields.pinned as never)(true)).toBe(1)
  })
})

describe('local fields', () => {
  it('are read and written like any other, since only the wire ignores them', () => {
    const notes = FIXTURE_INDEX.entity('notes')
    expect(notes.selectColumns).toContain('openedAt')

    expect(notes.decode({ openedAt: '2024-01-01T00:00:00.000Z' }).openedAt).toBeDefined()
  })
})

describe('the unique tuple', () => {
  const pair = (a: number, b: number) =>
    new SchemaIndex([
      {
        file: '0000',
        entities: {
          bookmarks: seed(
            Schema.Struct({
              id: key(1)(Schema.String),
              host: unique(a)(Schema.String),
              path: unique(b)(Schema.String),
              title: Schema.String,
            }),
          ),
        },
      },
    ]).entity('bookmarks')

  it('returns an empty tuple for an entity without unique fields', () => {
    expect(FIXTURE_INDEX.entity('notes').uniqueFields).toEqual([])
    expect(FIXTURE_INDEX.entity('notes').uniqueColumns).toEqual([])
  })

  it('orders by declared position rather than by declaration order', () => {
    expect(pair(2, 1).uniqueColumns).toEqual(['path', 'host'])
    expect(pair(1, 2).uniqueColumns).toEqual(['host', 'path'])
  })

  it('refuses two fields at one position, which would leave the order undecided', () => {
    // Duplicate positions make index and read ordering ambiguous.
    expect(() => pair(1, 1)).toThrow(/two unique fields at one position/)
  })

  it('drops a field that leaves the shape, since nothing writes it any more', () => {
    const born = {
      file: '0000',
      entities: {
        bookmarks: seed(
          Schema.Struct({
            id: key(1)(Schema.String),
            host: unique(1)(Schema.String),
            title: Schema.String,
          }),
        ),
      },
    } satisfies Migration

    const after = new SchemaIndex([
      born,
      {
        file: '0001',
        entities: { bookmarks: migrateSchema(shapeOf([born], 'bookmarks'), remove('host')) },
      },
    ]).entity('bookmarks')

    expect(after.uniqueColumns).toEqual([])
    // Removing a field retains its column and identity record.
    expect(after.selectColumns).toContain('host')
  })
})
