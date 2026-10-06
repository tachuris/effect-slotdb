import { describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import { migrateSchema, rename, retype, SchemaIndex, seed } from '../../migration'
import { FIXTURE_INDEX } from '../../testing.ts'
import { assertLiveColumns, assertWritableColumns } from './columns.ts'

const born = SchemaIndex.seed({
  file: '0000',
  entities: {
    notes: seed(
      Schema.Struct({
        title: Schema.String,
        kind: Schema.String,
        body: Schema.String,
      }),
    ),
  },
})

const evolved = born.appendMigration({
  file: '0001',
  entities: {
    notes: migrateSchema(
      born.schemas.notes,
      rename('title', 'heading'),
      retype('kind', Schema.Literals(['plain', 'list']), { encodeToOld: kind => kind }),
    ),
  },
})

const retypedNotes = evolved.byName.get('notes')!
const supersedingColumn = retypedNotes.fieldByName('kind')!.column

describe('assertLiveColumns', () => {
  it('accepts a column of a live field', () => {
    expect(() => assertLiveColumns(retypedNotes, ['body'])).not.toThrow()
  })

  it("accepts a renamed field's birth column", () => {
    expect(() => assertLiveColumns(retypedNotes, ['title'])).not.toThrow()
  })

  it('rejects a column no field stores', () => {
    expect(() => assertLiveColumns(retypedNotes, ['heading'])).toThrow(/no field of 'notes' stores/)
  })

  it('rejects the column a retype retired', () => {
    expect(() => assertLiveColumns(retypedNotes, ['kind'])).toThrow(/retired field 'kind'/)
  })

  it('rejects the column of a field that supersedes a retired one', () => {
    expect(supersedingColumn).not.toBe('kind')
    expect(() => assertLiveColumns(retypedNotes, [supersedingColumn])).toThrow(/supersedes/)
  })
})

describe('assertWritableColumns', () => {
  const fixtureNotes = FIXTURE_INDEX.typed.notes

  it('accepts a live local column', () => {
    expect(() => assertWritableColumns(fixtureNotes, ['openedAt'])).not.toThrow()
  })

  it('rejects a replicated column', () => {
    expect(() => assertWritableColumns(fixtureNotes, ['title'])).toThrow(
      /notes.title.*replicated.*typed/,
    )
  })

  it.each(['id', 'createdAt', 'deletedAt'])(
    'rejects the replicated key or framework column %s',
    column => {
      expect(() => assertWritableColumns(fixtureNotes, [column])).toThrow(/replicated/)
    },
  )

  it('rejects a column no field stores', () => {
    expect(() => assertWritableColumns(fixtureNotes, ['missing'])).toThrow(/no field/)
  })

  it('rejects retired and superseding columns', () => {
    expect(() => assertWritableColumns(retypedNotes, ['kind'])).toThrow(/retired field/)
    expect(() => assertWritableColumns(retypedNotes, [supersedingColumn])).toThrow(/supersedes/)
  })
})
