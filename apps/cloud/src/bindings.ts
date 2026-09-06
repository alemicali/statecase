import { DurableObject } from "cloudflare:workers";

import type { CommitRequest } from "@statecase/protocol";
import { VaultCoordinatorCore, type CommitResult, type CoordinatorStorage, type VaultHead } from "@statecase/sync-core";

import {
  ControlPlaneError,
  type AuthService,
  type CloudServices,
  type ControlPlane,
  type Coordinator,
  type DeviceSummary,
  type ObjectStore,
  type Principal,
  type VaultSummary,
} from "./app.js";
import { createBetterAuthService } from "./auth.js";

export interface StatecaseEnvironment extends Env {
  BETTER_AUTH_SECRET: string;
  STATECASE_ALLOWED_EMAILS: string;
  VAULTS: DurableObjectNamespace<VaultCoordinator>;
}

const authServices = new WeakMap<D1Database, AuthService>();

export class VaultCoordinator extends DurableObject<StatecaseEnvironment> {
  readonly #core: VaultCoordinatorCore;

  constructor(context: DurableObjectState, environment: StatecaseEnvironment) {
    super(context, environment);
    this.#core = new VaultCoordinatorCore(new DurableStorage(context.storage));
  }

  async head(): Promise<VaultHead | null> {
    return this.#core.head();
  }

  async commit(request: CommitRequest): Promise<CommitResult> {
    return this.#core.commit(request);
  }
}

export function createCloudServices(environment: StatecaseEnvironment): CloudServices {
  return {
    auth: cachedAuthService(environment),
    objects: new R2ObjectStore(environment.BLOBS),
    authorizeVault: (principal, vaultId, action) => authorizeVault(environment.DB, principal, vaultId, action),
    coordinator: (vaultId): Coordinator => environment.VAULTS.getByName(vaultId),
    control: new D1ControlPlane(environment.DB),
  };
}

function cachedAuthService(environment: StatecaseEnvironment): AuthService {
  const existing = authServices.get(environment.DB);
  if (existing) return existing;
  const created = createBetterAuthService(environment);
  authServices.set(environment.DB, created);
  return created;
}

class DurableStorage implements CoordinatorStorage {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.#storage.get<T>(key);
  }

  async putMany(entries: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#storage.put(entries);
  }
}

class R2ObjectStore implements ObjectStore {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  async putIfAbsent(
    vaultId: string,
    objectId: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<{ created: boolean; size: number }> {
    const key = objectKey(vaultId, objectId);
    const created = await this.#bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: { format: "statecase-envelope-v1", objectId, vaultId },
      httpMetadata: { contentType: "application/octet-stream" },
    });
    if (created) return { created: true, size: created.size };
    const existing = await this.#bucket.head(key);
    if (!existing) throw new Error("conditional object write lost its winner");
    return { created: false, size: existing.size };
  }

  async get(vaultId: string, objectId: string): Promise<ReadableStream<Uint8Array> | null> {
    const object = await this.#bucket.get(objectKey(vaultId, objectId));
    return object?.body ?? null;
  }

  async exists(vaultId: string, objectId: string): Promise<boolean> {
    return (await this.#bucket.head(objectKey(vaultId, objectId))) !== null;
  }
}

class D1ControlPlane implements ControlPlane {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async registerDevice(
    principal: Principal,
    input: { id: string; name: string; publicSigningKey?: string; publicExchangeKey?: string },
  ): Promise<{ accountId: string; deviceId: string; name: string }> {
    const sessionBinding = await this.#database.prepare(`
      SELECT device_id, revoked_at FROM device_sessions WHERE session_id = ? AND account_id = ? LIMIT 1
    `).bind(principal.sessionId, principal.accountId).first<{ device_id: string; revoked_at: number | null }>();
    if (sessionBinding && (sessionBinding.revoked_at !== null || sessionBinding.device_id !== input.id)) {
      throw new ControlPlaneError("device-required");
    }
    const existing = await this.#database.prepare(`
      SELECT account_id, status FROM devices WHERE id = ? LIMIT 1
    `).bind(input.id).first<{ account_id: string; status: DeviceSummary["status"] }>();
    if (existing && (existing.account_id !== principal.accountId || existing.status !== "active")) {
      throw new ControlPlaneError("device-required");
    }
    const now = Date.now();
    await this.#database.batch([
      this.#database.prepare(`
        INSERT INTO statecase_accounts (id, created_at, status) VALUES (?, ?, 'active')
        ON CONFLICT(id) DO NOTHING
      `).bind(principal.accountId, now),
      this.#database.prepare(`
        INSERT INTO devices (
          id, account_id, name, public_signing_key, public_exchange_key, status, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          public_signing_key = excluded.public_signing_key,
          public_exchange_key = excluded.public_exchange_key,
          last_seen_at = excluded.last_seen_at
        WHERE devices.account_id = excluded.account_id AND devices.status = 'active'
      `).bind(
        input.id,
        principal.accountId,
        input.name,
        input.publicSigningKey ?? null,
        input.publicExchangeKey ?? null,
        now,
        now,
      ),
      this.#database.prepare(`
        INSERT INTO device_sessions (session_id, account_id, device_id, created_at, revoked_at)
        VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(session_id) DO UPDATE SET
          device_id = excluded.device_id,
          revoked_at = NULL
        WHERE device_sessions.account_id = excluded.account_id
          AND device_sessions.device_id = excluded.device_id
          AND device_sessions.revoked_at IS NULL
      `).bind(principal.sessionId, principal.accountId, input.id, now),
      auditStatement(this.#database, principal, "device.register", "device", input.id, now),
    ]);
    return { accountId: principal.accountId, deviceId: input.id, name: input.name };
  }

  async createVault(principal: Principal, input: { name: string }): Promise<VaultSummary> {
    await this.#requireDevice(principal);
    const id = `vlt_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = Date.now();
    await this.#database.batch([
      this.#database.prepare(`
        INSERT INTO vaults (id, account_id, name, created_at, status) VALUES (?, ?, ?, ?, 'active')
      `).bind(id, principal.accountId, input.name, now),
      this.#database.prepare(`
        INSERT INTO vault_members (vault_id, device_id, role, created_at) VALUES (?, ?, 'owner', ?)
      `).bind(id, principal.deviceId, now),
      auditStatement(this.#database, principal, "vault.create", "vault", id, now),
    ]);
    return { id, name: input.name, role: "owner" };
  }

  async listDevices(principal: Principal): Promise<DeviceSummary[]> {
    await this.#requireDevice(principal);
    const rows = await this.#database.prepare(`
      SELECT id, name, status, created_at, last_seen_at
      FROM devices
      WHERE account_id = ?
      ORDER BY created_at, id
    `).bind(principal.accountId).all<{
      id: string;
      name: string;
      status: DeviceSummary["status"];
      created_at: number;
      last_seen_at: number;
    }>();
    return rows.results.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  async revokeDevice(principal: Principal, deviceId: string): Promise<void> {
    await this.#requireDevice(principal);
    const target = await this.#database.prepare(`
      SELECT id FROM devices WHERE id = ? AND account_id = ? LIMIT 1
    `).bind(deviceId, principal.accountId).first<{ id: string }>();
    if (!target) throw new ControlPlaneError("not-found");
    const now = Date.now();
    await this.#database.batch([
      this.#database.prepare(`
        UPDATE devices SET status = 'revoked', last_seen_at = ? WHERE id = ? AND account_id = ?
      `).bind(now, deviceId, principal.accountId),
      this.#database.prepare(`
        UPDATE vault_members SET revoked_at = COALESCE(revoked_at, ?) WHERE device_id = ?
      `).bind(now, deviceId),
      this.#database.prepare(`
        UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE device_id = ? AND account_id = ?
      `).bind(now, deviceId, principal.accountId),
      auditStatement(this.#database, principal, "device.revoke", "device", deviceId, now),
    ]);
  }

  async listVaults(principal: Principal): Promise<VaultSummary[]> {
    const rows = await this.#database.prepare(`
      SELECT v.id, v.name, vm.role
      FROM vaults AS v
      LEFT JOIN vault_members AS vm
        ON vm.vault_id = v.id AND vm.device_id = ? AND vm.revoked_at IS NULL
      WHERE v.account_id = ? AND v.status = 'active'
      ORDER BY v.created_at, v.id
    `).bind(principal.deviceId, principal.accountId).all<{ id: string; name: string; role: VaultSummary["role"] }>();
    return rows.results.map((row) => ({ id: row.id, name: row.name, role: row.role ?? null }));
  }

  async joinVault(principal: Principal, vaultId: string): Promise<VaultSummary> {
    await this.#requireDevice(principal);
    const vault = await this.#database.prepare(`
      SELECT id, name FROM vaults WHERE id = ? AND account_id = ? AND status = 'active' LIMIT 1
    `).bind(vaultId, principal.accountId).first<{ id: string; name: string }>();
    if (!vault) throw new ControlPlaneError("not-found");

    const existing = await this.#database.prepare(`
      SELECT role FROM vault_members WHERE vault_id = ? AND device_id = ? AND revoked_at IS NULL LIMIT 1
    `).bind(vaultId, principal.deviceId).first<{ role: Exclude<VaultSummary["role"], null> }>();
    if (existing) return { ...vault, role: existing.role };

    const now = Date.now();
    await this.#database.batch([
      this.#database.prepare(`
        INSERT INTO vault_members (vault_id, device_id, role, created_at)
        VALUES (?, ?, 'writer', ?)
        ON CONFLICT(vault_id, device_id) DO UPDATE SET role = 'writer', revoked_at = NULL, created_at = excluded.created_at
      `).bind(vaultId, principal.deviceId, now),
      auditStatement(this.#database, principal, "vault.join", "vault", vaultId, now),
    ]);
    return { ...vault, role: "writer" };
  }

  async #requireDevice(principal: Principal): Promise<void> {
    const device = await this.#database.prepare(`
      SELECT id FROM devices WHERE id = ? AND account_id = ? AND status = 'active' LIMIT 1
    `).bind(principal.deviceId, principal.accountId).first<{ id: string }>();
    if (!device) throw new ControlPlaneError("device-required");
  }
}

function auditStatement(
  database: D1Database,
  principal: Principal,
  action: string,
  targetType: string,
  targetId: string,
  now: number,
): D1PreparedStatement {
  return database.prepare(`
    INSERT INTO audit_events (
      id, account_id, device_id, action, target_type, target_id, outcome, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'success', '{}', ?)
  `).bind(`evt_${crypto.randomUUID().replaceAll("-", "")}`, principal.accountId, principal.deviceId, action, targetType, targetId, now);
}

async function authorizeVault(
  database: D1Database,
  principal: Principal,
  vaultId: string,
  action: "read" | "write",
): Promise<boolean> {
  const row = await database.prepare(`
    SELECT vm.role AS role
    FROM vaults AS v
    JOIN vault_members AS vm ON vm.vault_id = v.id
    JOIN devices AS d ON d.id = vm.device_id
    WHERE v.id = ? AND v.account_id = ? AND v.status = 'active'
      AND d.id = ? AND d.account_id = ? AND d.status = 'active'
      AND vm.revoked_at IS NULL
    LIMIT 1
  `).bind(vaultId, principal.accountId, principal.deviceId, principal.accountId).first<{ role: string }>();
  if (!row) return false;
  return action === "read" || row.role === "owner" || row.role === "writer" || row.role === "append";
}

function objectKey(vaultId: string, objectId: string): string {
  return `v1/vaults/${vaultId}/objects/${objectId.slice(0, 12)}/${objectId}`;
}
