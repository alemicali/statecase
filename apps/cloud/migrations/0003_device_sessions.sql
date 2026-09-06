PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS device_sessions (
  session_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES statecase_accounts(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS device_sessions_device
  ON device_sessions(device_id, revoked_at);
