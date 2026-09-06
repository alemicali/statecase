import { DurableObject } from "cloudflare:workers";

import type { CommitRequest, ScopedCommitRequest } from "@statecase/protocol";
import {
  VaultCoordinatorCore,
  type CommitResult,
  type CoordinatorStorage,
  type CreateSnapshotResult,
  type NamespaceHead,
  type ScopedCommitResult,
  type ScopedVaultHead,
  type VaultHead,
  type VaultRevision,
  type VaultSnapshot,
} from "@statecase/sync-core";

import {
  ControlPlaneError,
  type AuthService,
  type CapabilityService,
  type CapabilitySummary,
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

  async revision(revisionId: string): Promise<VaultRevision | null> {
    return this.#core.revision(revisionId);
  }

  async commit(request: CommitRequest): Promise<CommitResult> {
    return this.#core.commit(request);
  }

  async listSnapshots(): Promise<VaultSnapshot[]> {
    return this.#core.listSnapshots();
  }

  async createSnapshot(input: { id: string; name: string; createdAt: number }): Promise<CreateSnapshotResult> {
    return this.#core.createSnapshot(input);
  }

  async deleteSnapshot(snapshotId: string): Promise<boolean> {
    return this.#core.deleteSnapshot(snapshotId);
  }

  async namespaceHeads(allowedNamespaces?: ReadonlySet<string>): Promise<NamespaceHead[]> {
    return this.#core.namespaceHeads(allowedNamespaces);
  }

  async scopedHead(): Promise<ScopedVaultHead | null> {
    return this.#core.scopedHead();
  }

  async commitNamespaces(request: ScopedCommitRequest): Promise<ScopedCommitResult> {
    return this.#core.commitNamespaces(request);
  }
}

export function createCloudServices(environment: StatecaseEnvironment): CloudServices {
  return {
    auth: cachedAuthService(environment),
    objects: new R2ObjectStore(environment.BLOBS),
    authorizeVault: (principal, vaultId, action) => principal.capability
      ? Promise.resolve(false)
      : authorizeVault(environment.DB, principal, vaultId, action),
    authorizeNamespace: (principal, vaultId, namespace, action) => principal.capability
      ? Promise.resolve(action !== "write" && principal.capability.vaultId === vaultId && principal.capability.namespaces.includes(namespace) &&
          principal.capability.actions.includes(action))
      : authorizeVault(environment.DB, principal, vaultId, action === "read" ? "read" : "write"),
    coordinator: (vaultId): Coordinator => environment.VAULTS.getByName(vaultId),
    control: new D1ControlPlane(environment.DB),
    capabilities: new D1CapabilityService(environment.DB),
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
    body: ReadableStream<Uint8Array> | Uint8Array,
    namespace?: string,
  ): Promise<{ created: boolean; size: number }> {
    const key = objectKey(vaultId, objectId, namespace);
    const created = await this.#bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: { format: "statecase-envelope-v1", objectId, vaultId, ...(namespace ? { namespace } : {}) },
      httpMetadata: { contentType: "application/octet-stream" },
    });
    if (created) return { created: true, size: created.size };
    const existing = await this.#bucket.head(key);
    if (!existing) throw new Error("conditional object write lost its winner");
    return { created: false, size: existing.size };
  }

  async get(vaultId: string, objectId: string, namespace?: string): Promise<ReadableStream<Uint8Array> | null> {
    const object = await this.#bucket.get(objectKey(vaultId, objectId, namespace));
    return object?.body ?? null;
  }

  async exists(vaultId: string, objectId: string, namespace?: string): Promise<boolean> {
    return (await this.#bucket.head(objectKey(vaultId, objectId, namespace))) !== null;
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
      this.#database.prepare(`
        UPDATE capability_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE creator_device_id = ? AND account_id = ?
      `).bind(now, deviceId, principal.accountId),
      this.#database.prepare(`
        UPDATE capability_sessions SET revoked_at = COALESCE(revoked_at, ?)
        WHERE grant_id IN (SELECT id FROM capability_grants WHERE creator_device_id = ? AND account_id = ?)
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

class D1CapabilityService implements CapabilityService {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async create(principal: Principal, input: Parameters<CapabilityService["create"]>[1]): Promise<CapabilitySummary> {
    const now = Date.now();
    await this.#database.batch([
      this.#database.prepare(`
        INSERT INTO capability_grants (
          id, account_id, creator_device_id, vault_id, token_hash, namespaces_json,
          actions_json, key_envelope, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.id,
        principal.accountId,
        principal.deviceId,
        input.vaultId,
        input.tokenHash,
        JSON.stringify(input.namespaces),
        JSON.stringify(input.actions),
        input.keyEnvelope,
        input.expiresAt,
        now,
      ),
      auditStatement(this.#database, principal, "capability.create", "capability", input.id, now),
    ]);
    return {
      id: input.id,
      vaultId: input.vaultId,
      namespaces: input.namespaces,
      actions: input.actions,
      expiresAt: input.expiresAt,
      createdAt: now,
    };
  }

  async list(principal: Principal): Promise<CapabilitySummary[]> {
    const rows = await this.#database.prepare(`
      SELECT id, vault_id, namespaces_json, actions_json, expires_at, redeemed_at, revoked_at, created_at
      FROM capability_grants WHERE account_id = ? ORDER BY created_at DESC, id
    `).bind(principal.accountId).all<CapabilityRow>();
    return rows.results.map(capabilitySummary);
  }

  async revoke(principal: Principal, capabilityId: string): Promise<void> {
    const existing = await this.#database.prepare(`
      SELECT id FROM capability_grants WHERE id = ? AND account_id = ? LIMIT 1
    `).bind(capabilityId, principal.accountId).first<{ id: string }>();
    if (!existing) throw new ControlPlaneError("not-found");
    const now = Date.now();
    await this.#database.batch([
      this.#database.prepare(`
        UPDATE capability_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND account_id = ?
      `).bind(now, capabilityId, principal.accountId),
      this.#database.prepare(`
        UPDATE capability_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE grant_id = ?
      `).bind(now, capabilityId),
      auditStatement(this.#database, principal, "capability.revoke", "capability", capabilityId, now),
    ]);
  }

  async redeem(token: string): Promise<Awaited<ReturnType<CapabilityService["redeem"]>>> {
    const now = Date.now();
    const tokenHash = await sha256Base64Url(token);
    const grant = await this.#database.prepare(`
      UPDATE capability_grants
      SET redeemed_at = ?
      WHERE token_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      RETURNING id, account_id, vault_id, namespaces_json, actions_json, key_envelope, expires_at
    `).bind(now, tokenHash, now).first<CapabilityRedeemRow>();
    if (!grant) return null;
    const accessToken = `stc_access_${randomSecret()}`;
    const accessHash = await sha256Base64Url(accessToken);
    const sessionId = `cps_${crypto.randomUUID().replaceAll("-", "")}`;
    await this.#database.prepare(`
      INSERT INTO capability_sessions (id, grant_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(sessionId, grant.id, accessHash, grant.expires_at, now).run();
    return {
      accessToken,
      expiresAt: grant.expires_at,
      vaultId: grant.vault_id,
      namespaces: parseStringArray(grant.namespaces_json),
      actions: parseCapabilityActions(grant.actions_json),
      keyEnvelope: grant.key_envelope,
    };
  }
}

interface CapabilityRow {
  id: string;
  vault_id: string;
  namespaces_json: string;
  actions_json: string;
  expires_at: number;
  redeemed_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

interface CapabilityRedeemRow {
  id: string;
  account_id: string;
  vault_id: string;
  namespaces_json: string;
  actions_json: string;
  key_envelope: string;
  expires_at: number;
}

function capabilitySummary(row: CapabilityRow): CapabilitySummary {
  return {
    id: row.id,
    vaultId: row.vault_id,
    namespaces: parseStringArray(row.namespaces_json),
    actions: parseCapabilityActions(row.actions_json),
    expiresAt: row.expires_at,
    ...(row.redeemed_at === null ? {} : { redeemedAt: row.redeemed_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    createdAt: row.created_at,
  };
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("invalid stored capability namespaces");
  return parsed;
}

function parseCapabilityActions(value: string): Array<"read" | "append"> {
  const parsed = parseStringArray(value);
  if (parsed.some((item) => item !== "read" && item !== "append")) throw new Error("invalid stored capability actions");
  return parsed as Array<"read" | "append">;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return bytesToBase64Url(digest);
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
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
  action: "read" | "write" | "admin",
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
  if (action === "read") return true;
  if (action === "admin") return row.role === "owner";
  return row.role === "owner" || row.role === "writer" || row.role === "append";
}

function objectKey(vaultId: string, objectId: string, namespace?: string): string {
  const scope = namespace ? `/namespaces/${namespace}` : "";
  return `v1/vaults/${vaultId}${scope}/objects/${objectId.slice(0, 12)}/${objectId}`;
}
