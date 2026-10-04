/** Fixed metadata tables shared by stores and SQL drivers. */

/**
 * The stamp table. One row per replicated slot, keyed the same way a change addresses
 * one.
 */
export const STAMPS_TABLE = 'fieldStamps'

/** Values for unknown field IDs, keyed by the same slot address as stamps. */
export const OVERFLOW_TABLE = 'fieldOverflow'

/** Invalid known field values retained for inspection without advancing their stamps. */
export const DEAD_LETTER_TABLE = 'fieldDeadLetters'

const SIDE_TABLES = [
  `CREATE TABLE ${STAMPS_TABLE} (
  entityId TEXT NOT NULL,
  rowId TEXT NOT NULL,
  fieldId TEXT NOT NULL,
  hlc TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entityId, rowId, fieldId)
)`,
  `CREATE INDEX idx_${STAMPS_TABLE}_seq ON ${STAMPS_TABLE} (seq)`,
  `CREATE TABLE ${OVERFLOW_TABLE} (
  entityId TEXT NOT NULL,
  rowId TEXT NOT NULL,
  fieldId TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (entityId, rowId, fieldId)
)`,
  `CREATE TABLE ${DEAD_LETTER_TABLE} (
  entityId TEXT NOT NULL,
  rowId TEXT NOT NULL,
  fieldId TEXT NOT NULL,
  value TEXT,
  hlc TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (entityId, rowId, fieldId)
)`,
] as const

/** The side tables, in the order a first migration has to create them. */
export const sideTableDdl = (): ReadonlyArray<string> => SIDE_TABLES
