import * as fs from 'node:fs'
import type { DerivedMigration } from './ddl.ts'

/** Reads and renders committed migration SQL at caller supplied paths. */

/** The committed DDL, or `undefined` before one exists. */
export const readDdl = (path: string): string | undefined =>
  fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : undefined

/**
 * Renders SQL in migration sections with terminated statements. Sections make changes to
 * applied migrations visible in reviews.
 */
export const renderDdl = (migrations: ReadonlyArray<DerivedMigration>): string =>
  `${migrations
    .map(migration =>
      [
        `-- ${String(migration.id).padStart(4, '0')}_${migration.name}`,
        ...migration.statements.map(statement => `${statement};`),
      ].join('\n\n'),
    )
    .join('\n\n')}\n`
