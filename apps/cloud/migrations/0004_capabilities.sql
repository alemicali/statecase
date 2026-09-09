PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS capability_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES statecase_accounts(id),
  creator_device_id TEXT NOT NULL REFERENCES devices(id),
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  token_hash TEXT NOT NULL UNIQUE,
  namespaces_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  key_envelope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS capability_grants_account
  ON capability_grants(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS capability_grants_active
  ON capability_grants(token_hash, expires_at, redeemed_at, revoked_at);

CREATE TABLE IF NOT EXISTS capability_sessions (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES capability_grants(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS capability_sessions_active
  ON capability_sessions(token_hash, expires_at, revoked_at);
