PRAGMA foreign_keys = ON;

ALTER TABLE vaults ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 1 CHECK (key_epoch >= 1);
ALTER TABLE capability_grants ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 1 CHECK (key_epoch >= 1);
ALTER TABLE vault_members ADD COLUMN enrolled_key_epoch INTEGER NOT NULL DEFAULT 1 CHECK (enrolled_key_epoch >= 1);

CREATE TRIGGER vault_member_current_key_epoch
BEFORE INSERT ON vault_members
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM vaults AS v JOIN devices AS d ON d.id = NEW.device_id AND d.account_id = v.account_id
    WHERE v.id = NEW.vault_id AND v.status = 'active' AND d.status = 'active'
      AND v.key_epoch = NEW.enrolled_key_epoch
  ) THEN RAISE(ABORT, 'invalid vault enrollment epoch') END;
END;

CREATE TRIGGER device_exchange_key_immutable
BEFORE UPDATE OF public_exchange_key ON devices
WHEN OLD.public_exchange_key IS NOT NULL AND NEW.public_exchange_key IS NOT OLD.public_exchange_key
BEGIN
  SELECT RAISE(ABORT, 'device exchange key is immutable');
END;

CREATE TRIGGER capability_current_key_epoch
BEFORE INSERT ON capability_grants
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM vaults AS v
    JOIN vault_members AS vm ON vm.vault_id = v.id AND vm.device_id = NEW.creator_device_id
    JOIN devices AS d ON d.id = vm.device_id AND d.account_id = v.account_id
    WHERE v.id = NEW.vault_id AND v.account_id = NEW.account_id
      AND v.status = 'active' AND v.key_epoch = NEW.key_epoch
      AND vm.role = 'owner' AND vm.revoked_at IS NULL AND d.status = 'active'
  ) THEN RAISE(ABORT, 'invalid capability epoch or issuer') END;
END;

CREATE TABLE vault_key_envelopes (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  key_epoch INTEGER NOT NULL CHECK (key_epoch >= 2),
  device_id TEXT NOT NULL REFERENCES devices(id),
  envelope TEXT NOT NULL,
  created_by_device_id TEXT NOT NULL REFERENCES devices(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, key_epoch, device_id)
) STRICT;

CREATE INDEX vault_key_envelopes_device
  ON vault_key_envelopes(device_id, vault_id, key_epoch DESC);

CREATE TRIGGER vault_key_envelope_active_recipient
BEFORE INSERT ON vault_key_envelopes
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM vaults AS v
    JOIN vault_members AS vm ON vm.vault_id = v.id AND vm.device_id = NEW.created_by_device_id
    JOIN devices AS d ON d.id = vm.device_id AND d.account_id = v.account_id
    WHERE v.id = NEW.vault_id AND v.status = 'active'
      AND vm.role = 'owner' AND vm.revoked_at IS NULL AND d.status = 'active'
  ) THEN RAISE(ABORT, 'invalid vault key issuer') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM vaults AS v
    JOIN vault_members AS vm ON vm.vault_id = v.id
    JOIN devices AS d ON d.id = vm.device_id
    WHERE v.id = NEW.vault_id
      AND NEW.key_epoch = v.key_epoch + 1
      AND vm.device_id = NEW.device_id
      AND vm.revoked_at IS NULL
      AND d.status = 'active'
      AND d.public_exchange_key IS NOT NULL
  ) THEN RAISE(ABORT, 'invalid vault key recipient') END;
END;

CREATE TRIGGER vault_key_epoch_exact_recipients
BEFORE UPDATE OF key_epoch ON vaults
BEGIN
  SELECT CASE WHEN NEW.key_epoch != OLD.key_epoch + 1 THEN
    RAISE(ABORT, 'invalid vault key epoch') END;
  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM vault_members AS vm
    JOIN devices AS d ON d.id = vm.device_id
    WHERE vm.vault_id = OLD.id
      AND vm.revoked_at IS NULL
      AND d.status = 'active'
      AND d.public_exchange_key IS NOT NULL
  ) != (
    SELECT COUNT(*)
    FROM vault_key_envelopes AS envelope
    WHERE envelope.vault_id = OLD.id AND envelope.key_epoch = NEW.key_epoch
  ) THEN RAISE(ABORT, 'incomplete vault key recipients') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM vault_members AS vm
    JOIN devices AS d ON d.id = vm.device_id
    WHERE vm.vault_id = OLD.id
      AND vm.revoked_at IS NULL
      AND d.status = 'active'
      AND d.public_exchange_key IS NULL
  ) THEN RAISE(ABORT, 'active device lacks exchange key') END;
END;
