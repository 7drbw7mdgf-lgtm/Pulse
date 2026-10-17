-- Pulse relay (D1). Sync rows are end-to-end encrypted; the relay cannot read them.
CREATE TABLE IF NOT EXISTS vaults (
  vault_id TEXT PRIMARY KEY,
  auth_hash TEXT NOT NULL,
  head INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  touched INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  vault_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  device TEXT NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY (vault_id, record_id)
);
CREATE INDEX IF NOT EXISTS records_by_seq ON records (vault_id, seq);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  version TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
