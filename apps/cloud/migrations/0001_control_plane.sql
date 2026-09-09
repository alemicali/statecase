PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS statecase_accounts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended'))
) STRICT;

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES statecase_accounts(id),
  name TEXT NOT NULL,
  public_signing_key TEXT,
  public_exchange_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS devices_account ON devices(account_id, status);

CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES statecase_accounts(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'frozen'))
) STRICT;
CREATE INDEX IF NOT EXISTS vaults_account ON vaults(account_id, status);

CREATE TABLE IF NOT EXISTS vault_members (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'writer', 'reader', 'append')),
  wrapped_key_ref TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (vault_id, device_id)
) STRICT;

CREATE TABLE IF NOT EXISTS bootstrap_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES statecase_accounts(id),
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  workspace_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS bootstrap_tokens_active ON bootstrap_tokens(token_hash, expires_at);

CREATE TABLE IF NOT EXISTS workspaces (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  canonical_remote TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  outcome TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS audit_events_account_time ON audit_events(account_id, created_at DESC);
