import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import {
  addOptional,
  addRequired,
  SchemaIndex,
  migrateSchema,
  mergeFields,
  type Migration,
  OVERFLOW_TABLE,
  remove,
  retype,
  seed,
  shapeOf,
  STAMPS_TABLE,
} from '@tachuris/effect-slotdb/migration'
import { FIXTURE_INDEX } from './testing.ts'
import { makeInMemorySqliteLayer } from './testing.ts'
import { type ColumnSpec, columnSpecs, deriveDdl, deriveMigrations, managedTables } from './ddl.ts'
import { assertDatabaseMatches, checkDatabase, compareColumns } from './guard.ts'

/** Runs statements against a fresh database in memory and invokes the callback. */
const withDatabase = <A, E>(
  statements: ReadonlyArray<string>,
  use: Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) yield* sql.unsafe(statement)
    return yield* use
  }).pipe(Effect.provide(makeInMemorySqliteLayer()))

describe('the derived DDL builds a real database', () => {
  it('creates all managed tables and passes the boot guard', () =>
    Effect.runPromise(
      withDatabase(
        deriveDdl(FIXTURE_INDEX.chain),
        Effect.gen(function* () {
          const mismatches = yield* checkDatabase(FIXTURE_INDEX)
          expect(mismatches).toEqual([])
        }),
      ),
    ))

  it('creates a rowId primary key for every table', () =>
    Effect.runPromise(
      withDatabase(
        deriveDdl(FIXTURE_INDEX.chain),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          for (const table of managedTables(FIXTURE_INDEX)) {
            const rows = yield* sql`
  SELECT
    name,
    pk
  FROM
    pragma_table_info (${table})
`
            const primary = (rows as ReadonlyArray<{ name: string; pk: number }>).filter(
              r => r.pk > 0,
            )
            expect(
              primary.map(r => r.name),
              table,
            ).toEqual(['__rowId'])
          }
        }),
      ),
    ))

  it('builds a unique index over each natural key', () =>
    Effect.runPromise(
      withDatabase(
        deriveDdl(FIXTURE_INDEX.chain),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql`
  SELECT
    name,
    "unique"
  FROM
    pragma_index_list ('readings')
`
          const unique = (rows as ReadonlyArray<{ name: string; unique: number }>).filter(
            r => r.unique === 1,
          )
          expect(unique.map(r => r.name)).toContain('idx_readings_key')

          const columns = yield* sql`
  SELECT
    name
  FROM
    pragma_index_info ('idx_readings_key')
  ORDER BY
    seqno
`
          expect((columns as ReadonlyArray<{ name: string }>).map(c => c.name)).toEqual([
            'noteId',
            'readerId',
          ])
        }),
      ),
    ))

  it('enforces that unique index, so two rows cannot share a natural key', () =>
    Effect.runPromise(
      withDatabase(
        deriveDdl(FIXTURE_INDEX.chain),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const insert = (rowId: string) =>
            sql.unsafe(
              `INSERT INTO readings (__rowId, noteId, readerId) ` + `VALUES ('${rowId}', 'a', 'b')`,
            )

          yield* insert('row-1')
          const clash = yield* Effect.result(insert('row-2'))
          expect(clash._tag).toBe('Failure')
        }),
      ),
    ))

  it('creates a nonunique index over a unique tuple', () =>
    Effect.runPromise(
      withDatabase(
        deriveDdl(FIXTURE_INDEX.chain),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const rows = (yield* sql`
  SELECT
    name,
    "unique"
  FROM
    pragma_index_list ('aliases')
`) as ReadonlyArray<{ name: string; unique: number }>

          const index = rows.find(r => r.name === 'idx_aliases_unique')
          expect(index).toBeDefined()
          expect(index!.unique).toBe(0)

          const columns = yield* sql`
  SELECT
    name
  FROM
    pragma_index_info ('idx_aliases_unique')
  ORDER BY
    seqno
`
          expect((columns as ReadonlyArray<{ name: string }>).map(c => c.name)).toEqual(['name'])
        }),
      ),
    ))

  it('permits two live rows to share a unique tuple for replication', () =>
    Effect.runPromise(
      withDatabase(
        deriveDdl(FIXTURE_INDEX.chain),
        Effect.gen(function* () {
          // A nonunique index permits both peers to replicate rows with the same tuple.
          const sql = yield* SqlClient.SqlClient
          const insert = (rowId: string) =>
            sql.unsafe(
              `INSERT INTO aliases (__rowId, id, name) VALUES ('${rowId}', '${rowId}', 'focus')`,
            )

          yield* insert('row-1')
          const second = yield* Effect.result(insert('row-2'))
          expect(second._tag).toBe('Success')
        }),
      ),
    ))

  it('creates the stamp and overflow tables, keyed the same way', () =>
    Effect.runPromise(
      withDatabase(
        deriveDdl(FIXTURE_INDEX.chain),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          for (const table of [STAMPS_TABLE, OVERFLOW_TABLE]) {
            const rows = yield* sql`
  SELECT
    name,
    pk
  FROM
    pragma_table_info (${table})
`
            const key = (rows as ReadonlyArray<{ name: string; pk: number }>)
              .filter(r => r.pk > 0)
              .sort((a, b) => a.pk - b.pk)
              .map(r => r.name)
            expect(key, table).toEqual(['entityId', 'rowId', 'fieldId'])
          }
        }),
      ),
    ))
})

describe('which fields get a column', () => {
  const born = {
    file: '0000',
    entities: {
      person: seed(Schema.Struct({ id: Schema.String, first: Schema.String, last: Schema.String })),
    },
  } satisfies Migration

  const nicknamed = {
    file: '0001',
    entities: {
      person: migrateSchema(shapeOf([born], 'person'), addOptional('nickname', Schema.String)),
    },
  } satisfies Migration

  const trimmed = {
    file: '0002',
    entities: { person: migrateSchema(shapeOf([born, nicknamed], 'person'), remove('nickname')) },
  } satisfies Migration

  const chain: readonly Migration[] = [
    born,
    nicknamed,
    trimmed,
    {
      file: '0003',
      entities: {
        person: migrateSchema(
          shapeOf([born, nicknamed, trimmed], 'person'),
          mergeFields(['first', 'last'], 'full', Schema.String, {
            combine: (a, b) => `${a} ${b}`,
            split: (v: string) => [v, ''],
          }),
        ),
      },
    },
  ]

  const index = new SchemaIndex(chain)
  const person = index.entity('person')
  const columnNames = columnSpecs(person).map(spec => spec.name)

  it('retains the column of a removed field', () => {
    // Retired columns must accept writes from older peers.
    expect(columnNames).toContain('nickname')
  })

  it('retains the column of a replicated merge source', () => {
    expect(columnNames).toContain('first')
    expect(columnNames).toContain('last')
  })

  it('omits a column for a field computed on read', () => {
    expect(columnNames).not.toContain('full')
  })

  it('creates a table that matches the derived column specifications', () =>
    Effect.runPromise(
      withDatabase(
        deriveDdl(chain),
        Effect.gen(function* () {
          expect(yield* checkDatabase(index)).toEqual([])
        }),
      ),
    ))
})

describe('one migration per chain file', () => {
  const born = {
    file: '0000',
    name: 'notes',
    entities: { note: seed(Schema.Struct({ id: Schema.String, body: Schema.String })) },
    sql: [`INSERT INTO note (__rowId, id, body) VALUES ('r1', 'i1', 'seeded')`],
  } satisfies Migration

  const stamped = shapeOf([born], 'note')

  const chain: readonly Migration[] = [
    born,
    {
      file: '0001',
      name: 'tags',
      entities: { note: migrateSchema(stamped, addOptional('tag', Schema.String)) },
    },
  ]

  const migrations = deriveMigrations(chain)

  it('numbers from one, because a migrator skips anything at or below zero', () => {
    expect(migrations.map(m => m.id)).toEqual([1, 2])
  })

  it('names each migration after its chain file', () => {
    expect(migrations.map(m => m.name)).toEqual(['notes', 'tags'])
  })

  it('creates a table only in the migration file that declares the table', () => {
    expect(migrations[0].statements.some(s => s.startsWith('CREATE TABLE note'))).toBe(true)
    expect(migrations[1].statements.some(s => s.includes('CREATE TABLE note'))).toBe(false)
  })

  it('adds a later field as a column rather than rebuilding the table', () => {
    expect(migrations[1].statements).toEqual(['ALTER TABLE note ADD COLUMN tag TEXT'])
  })

  it('creates replication metadata tables in the first migration', () => {
    expect(migrations[0].statements[0]).toContain(`CREATE TABLE ${STAMPS_TABLE}`)
    expect(migrations[1].statements.some(s => s.includes(STAMPS_TABLE))).toBe(false)
  })

  it('runs a custom step against the schema produced by the same migration', () =>
    Effect.runPromise(
      withDatabase(
        migrations[0].statements,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql`
  SELECT
    body
  FROM
    note
`
          expect(rows).toEqual([{ body: 'seeded' }])
        }),
      ),
    ))

  it('refuses a non-nullable column added to a table that already exists', () => {
    // Existing rows need a default for a new nonnullable column.
    // Required field additions provide defaults, but retypes may omit a default.
    const bad: readonly Migration[] = [
      born,
      {
        file: '0001',
        entities: {
          note: migrateSchema(stamped, retype('body', Schema.String, { encodeToOld: s => s })),
        },
      },
    ]
    expect(() => deriveMigrations(bad)).toThrow(/'note\.body/)
  })

  it('accepts a new nonnullable column with a default', () => {
    const good: readonly Migration[] = [
      born,
      {
        file: '0001',
        entities: {
          note: migrateSchema(
            stamped,
            addRequired('kind', Schema.String, () => 'x'),
          ),
        },
      },
    ]
    expect(deriveMigrations(good)[1].statements).toEqual([
      `ALTER TABLE note ADD COLUMN kind TEXT NOT NULL DEFAULT 'x'`,
    ])
  })
})

describe('the boot guard', () => {
  it('reports a column the derivation does not account for', () =>
    Effect.runPromise(
      withDatabase(
        [...deriveDdl(FIXTURE_INDEX.chain), `ALTER TABLE notes ADD COLUMN smuggled TEXT`],
        Effect.gen(function* () {
          const mismatches = yield* checkDatabase(FIXTURE_INDEX)
          expect(mismatches).toHaveLength(1)
          expect(mismatches[0].table).toBe('notes')
          expect(mismatches[0].unaccounted).toEqual(['smuggled'])
        }),
      ),
    ))

  it('reports a table that was never created', () =>
    Effect.runPromise(
      withDatabase(
        // Remove the table's index with the table so missing table detection can run.
        deriveDdl(FIXTURE_INDEX.chain).filter(s => !s.includes(' notes')),
        Effect.gen(function* () {
          const mismatches = yield* checkDatabase(FIXTURE_INDEX)
          expect(mismatches.map(m => m.table)).toContain('notes')
        }),
      ),
    ))

  it('reports a missing unique index over the natural key', () =>
    Effect.runPromise(
      withDatabase(
        [...deriveDdl(FIXTURE_INDEX.chain), `DROP INDEX idx_notes_key`],
        Effect.gen(function* () {
          const mismatches = yield* checkDatabase(FIXTURE_INDEX)
          expect(mismatches.map(m => m.table)).toEqual(['notes'])
          expect(mismatches[0].indexes).toEqual(['missing unique index idx_notes_key'])
        }),
      ),
    ))

  it('reports a missing index over the unique tuple', () =>
    Effect.runPromise(
      withDatabase(
        [...deriveDdl(FIXTURE_INDEX.chain), `DROP INDEX idx_aliases_unique`],
        Effect.gen(function* () {
          const mismatches = yield* checkDatabase(FIXTURE_INDEX)
          expect(mismatches.map(m => m.table)).toEqual(['aliases'])
          expect(mismatches[0].indexes).toEqual(['missing index idx_aliases_unique'])
        }),
      ),
    ))

  it('reports a unique index where the tuple requires a nonunique index', () =>
    // Reject unique tuple indexes before incoming duplicate values can stop replication.
    Effect.runPromise(
      withDatabase(
        [
          ...deriveDdl(FIXTURE_INDEX.chain),
          `DROP INDEX idx_aliases_unique`,
          `CREATE UNIQUE INDEX idx_aliases_unique ON aliases (name)`,
        ],
        Effect.gen(function* () {
          const mismatches = yield* checkDatabase(FIXTURE_INDEX)
          expect(mismatches.map(m => m.table)).toEqual(['aliases'])
          expect(mismatches[0].indexes[0]).toContain('is unique')
        }),
      ),
    ))

  it('reports a primary key that is not the row id', () =>
    // Matching names do not ensure the row ID column is a nonnullable primary key.
    Effect.runPromise(
      withDatabase(
        [
          ...deriveDdl(FIXTURE_INDEX.chain).filter(s => !s.includes(' notes')),
          `CREATE TABLE notes (
             __rowId TEXT NOT NULL, allocatedTimeMs INTEGER, deleted INTEGER NOT NULL DEFAULT 0,
             dueAt TEXT, id TEXT PRIMARY KEY NOT NULL, notesTemplate TEXT,
             recurrenceIsRelative INTEGER NOT NULL DEFAULT 0, recurrencePattern TEXT,
             schedule TEXT NOT NULL DEFAULT 'once', title TEXT NOT NULL)`,
          `CREATE UNIQUE INDEX idx_notes_key ON notes (id)`,
        ],
        Effect.gen(function* () {
          const mismatches = yield* checkDatabase(FIXTURE_INDEX)
          expect(mismatches.map(m => m.table)).toEqual(['notes'])
          expect(mismatches[0].differing.map(d => d.column)).toEqual(['__rowId', 'id'])
        }),
      ),
    ))

  it('fails startup when the boot guard detects a mismatch', () =>
    Effect.runPromise(
      withDatabase(
        [...deriveDdl(FIXTURE_INDEX.chain), `ALTER TABLE notes ADD COLUMN smuggled TEXT`],
        Effect.gen(function* () {
          const outcome = yield* Effect.result(assertDatabaseMatches(FIXTURE_INDEX))
          expect(outcome._tag).toBe('Failure')
          if (outcome._tag === 'Failure') {
            expect(outcome.failure.message).toContain('smuggled')
          }
        }),
      ),
    ))

  it('accepts a database created from the derived DDL', () =>
    Effect.runPromise(
      withDatabase(deriveDdl(FIXTURE_INDEX.chain), assertDatabaseMatches(FIXTURE_INDEX)),
    ))
})

describe('compareColumns', () => {
  const spec = (name: string): ColumnSpec => ({
    name,
    type: 'TEXT',
    notNull: false,
    primaryKey: false,
  })
  const found = (name: string) => ({ name, type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 })

  it('reports no differences for matching columns in any order', () => {
    expect(compareColumns('t', [spec('a'), spec('b')], [found('b'), found('a')])).toEqual({
      table: 't',
      missing: [],
      unaccounted: [],
      differing: [],
    })
  })

  it('reports both directions separately', () => {
    expect(compareColumns('t', [spec('a'), spec('b')], [found('a'), found('c')])).toEqual({
      table: 't',
      missing: ['b'],
      unaccounted: ['c'],
      differing: [],
    })
  })

  it('reports a column that is present under the right name with the wrong shape', () => {
    // Compare primary key flags in addition to column names.
    const mismatch = compareColumns(
      't',
      [{ name: '__rowId', type: 'TEXT', notNull: true, primaryKey: true }],
      [{ name: '__rowId', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }],
    )
    expect(mismatch.differing).toEqual([
      { column: '__rowId', expected: 'TEXT PRIMARY KEY NOT NULL', found: 'TEXT NULL' },
    ])
  })
})

describe('an open literal union column', () => {
  it('stores TEXT and keeps the field required', () => {
    const level = columnSpecs(FIXTURE_INDEX.entity('signals')).find(spec => spec.name === 'level')
    expect(level).toMatchObject({ type: 'TEXT', notNull: true })
  })
})
