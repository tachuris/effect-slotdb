-- 0001_support

CREATE TABLE fieldStamps (
  entityId TEXT NOT NULL,
  rowId TEXT NOT NULL,
  fieldId TEXT NOT NULL,
  hlc TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entityId, rowId, fieldId)
);

CREATE INDEX idx_fieldStamps_seq ON fieldStamps (seq);

CREATE TABLE fieldOverflow (
  entityId TEXT NOT NULL,
  rowId TEXT NOT NULL,
  fieldId TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (entityId, rowId, fieldId)
);

CREATE TABLE fieldDeadLetters (
  entityId TEXT NOT NULL,
  rowId TEXT NOT NULL,
  fieldId TEXT NOT NULL,
  value TEXT,
  hlc TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (entityId, rowId, fieldId)
);

CREATE TABLE peers (
  __rowId TEXT PRIMARY KEY NOT NULL,
  accountId TEXT NOT NULL,
  chainPosition TEXT,
  deletedAt TEXT,
  label TEXT,
  lastSeenAt TEXT,
  peerId TEXT NOT NULL,
  pulledThrough INTEGER,
  registeredAt TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_peers_key ON peers (peerId, accountId);

CREATE TABLE syncMeta (
  __rowId TEXT PRIMARY KEY NOT NULL,
  id INTEGER NOT NULL,
  peerId TEXT NOT NULL,
  pullCursor INTEGER NOT NULL DEFAULT 0,
  pushCursor INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_syncMeta_key ON syncMeta (id);

-- 0002_tasks

CREATE TABLE labels (
  __rowId TEXT PRIMARY KEY NOT NULL,
  color TEXT,
  createdAt TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  deletedAt TEXT,
  id TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_labels_key ON labels (id);

CREATE INDEX idx_labels_unique ON labels (name);

CREATE TABLE tasks (
  __rowId TEXT PRIMARY KEY NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  deletedAt TEXT,
  id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'personal',
  notes TEXT,
  slug TEXT NOT NULL,
  tags TEXT,
  title TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_tasks_key ON tasks (id);

CREATE INDEX idx_tasks_unique ON tasks (slug);

-- 0003_task-due-dates

ALTER TABLE tasks ADD COLUMN dueAt TEXT;
