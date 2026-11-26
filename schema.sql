-- Cloudflare D1 schema for ApexTraining (Base44-free)
-- Generic document store: every Base44 "entity" is a row in `entities`,
-- keyed by entity_type, with its fields in a JSON blob.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  role          TEXT DEFAULT 'user',          -- 'admin' | 'user'
  user_type     TEXT,                         -- 'trainer' | 'client' | 'independent'
  data          TEXT DEFAULT '{}',            -- JSON: everything else (business_name, avatar, prefs…)
  created_date  TEXT NOT NULL,
  updated_date  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  data         TEXT NOT NULL DEFAULT '{}',    -- JSON blob of all fields
  created_by   TEXT,                          -- user id/email of creator
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_type_created ON entities(entity_type, created_date);
CREATE INDEX IF NOT EXISTS idx_entities_created_by ON entities(created_by);

-- Guardians: a parent's Client record can book for a linked child's Client
-- record. Unlinking sets removed_date; rows are never deleted.
-- (The API also creates this on startup: GUARDIAN_SCHEMA in functions/api/[[path]].js.)
CREATE TABLE IF NOT EXISTS client_guardians (
  client_id          TEXT NOT NULL,           -- the child (Client entity id)
  guardian_client_id TEXT NOT NULL,           -- the guardian (Client entity id)
  created_by         TEXT,
  created_date       TEXT NOT NULL,
  removed_by         TEXT,
  removed_date       TEXT,
  PRIMARY KEY (client_id, guardian_client_id)
);
CREATE INDEX IF NOT EXISTS idx_client_guardians_guardian ON client_guardians(guardian_client_id);
