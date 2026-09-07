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
  KeyEpochConflict,
  RecoveryEpochConflict,
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
  STATECASE_GC_GRACE_DAYS: string;
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

  async commit(request: CommitRequest, vaultId: string): Promise<CommitResult | { outcome: "key-epoch-conflict" }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.#keyEpoch(vaultId) !== 1) return { outcome: "key-epoch-conflict" as const };
      return this.#core.commit(request);
    });
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

  async namespaceRevision(namespace: string, revisionId: string) {
    return this.#core.namespaceRevision(namespace, revisionId);
  }

  async scopedHead(): Promise<ScopedVaultHead | null> {
    return this.#core.scopedHead();
  }

  async scopedRevision(revisionId: string) {
    return this.#core.scopedRevision(revisionId);
  }

  async commitNamespaces(request: ScopedCommitRequest, vaultId: string): Promise<ScopedCommitResult | { outcome: "key-epoch-conflict" }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const epoch = await this.#keyEpoch(vaultId);
      if (epoch === null || request.updates.some((update) => (update.keyEpoch ?? 1) !== epoch)) {
        return { outcome: "key-epoch-conflict" as const };
      }
      return this.#core.commitNamespaces(request);
    });
  }

  async rotateVaultKey(principal: Principal, vaultId: string, input: Parameters<ControlPlane["rotateVaultKey"]>[2]) {
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      if (!(await authorizeVault(this.env.DB, principal, vaultId, "admin"))) throw new ControlPlaneError("not-found");
      const control = new D1ControlPlane(this.env.DB);
      const rejected = await control.validateVaultKeyRotation(principal, vaultId, input);
      if (rejected) return rejected;
      // Persist before sending D1 the transaction. An unknown/late D1 result
      // after object reset must never reopen writes encrypted with the old key.
      // Do not roll back this floor on failure; retrying a valid rotation to
      // the same next epoch safely completes it, even after a recipient race.
      const floorKey = `key-epoch-floor:${vaultId}`;
      const floor = await this.ctx.storage.get<number>(floorKey) ?? 1;
      await this.ctx.storage.put(floorKey, Math.max(floor, input.newEpoch));
      try {
        return await control.rotateVaultKey(principal, vaultId, input);
      } catch {
        // Return through the gate before surfacing the sanitized error. A D1
        // outage must preserve the fence without breaking every existing stub.
        return { outcome: "unavailable" as const };
      }
    });
    if (result.outcome === "unavailable") throw new Error("vault key rotation outcome unavailable");
    return result;
  }

  async #keyEpoch(vaultId: string): Promise<number | null> {
    const vault = await this.env.DB.prepare("SELECT key_epoch FROM vaults WHERE id = ? AND status = 'active'")
      .bind(vaultId).first<{ key_epoch: number }>();
    const floor = await this.ctx.storage.get<number>(`key-epoch-floor:${vaultId}`) ?? 1;
    return vault && vault.key_epoch >= floor ? vault.key_epoch : null;
  }

  async planGarbageCollection(input: Parameters<VaultCoordinatorCore["planGarbageCollection"]>[0]) {
    return this.#core.planGarbageCollection(input);
  }

  async finalizeGarbageCollection(planId: string): Promise<boolean> {
    return this.#core.finalizeGarbageCollection(planId);
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
    control: new CoordinatedControlPlane(environment),
    capabilities: new D1CapabilityService(environment.DB),
    garbageCollectionGracePeriodMs: garbageCollectionGracePeriod(environment.STATECASE_GC_GRACE_DAYS),
  };
}

function garbageCollectionGracePeriod(encodedDays: string | undefined): number {
  if (encodedDays === undefined) return 30 * 24 * 60 * 60 * 1000;
  const days = Number(encodedDays);
  if (!Number.isSafeInteger(days) || days < 0 || days > 365) throw new Error("STATECASE_GC_GRACE_DAYS must be an integer from 0 to 365");
  return days * 24 * 60 * 60 * 1000;
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

  async list<T>(prefix: string, limit: number): Promise<Map<string, T>> {
    const output = new Map<string, T>();
    let startAfter: string | undefined;
    while (output.size < limit) {
      const remaining = limit - output.size;
      const page = await this.#storage.list<T>({ prefix, startAfter, limit: Math.min(1_000, remaining + 1) });
      if (page.size === 0) return output;
      for (const [key, value] of page) {
        if (output.size >= limit) throw new Error("coordinator storage listing exceeds the safety limit");
        output.set(key, value);
        startAfter = key;
      }
      if (page.size < Math.min(1_000, remaining + 1)) return output;
    }
    const overflow = await this.#storage.list<T>({ prefix, startAfter, limit: 1 });
    if (overflow.size > 0) throw new Error("coordinator storage listing exceeds the safety limit");
    return output;
  }

  async putMany(entries: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#storage.put(entries);
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += 128) await this.#storage.delete(keys.slice(index, index + 128));
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

  async list(vaultId: string): Promise<Array<{ namespace: string | null; objectId: string; uploadedAt: number; size: number }>> {
    const prefix = `v1/vaults/${vaultId}/`;
    const output: Array<{ namespace: string | null; objectId: string; uploadedAt: number; size: number }> = [];
    let cursor: string | undefined;
    do {
      const page = await this.#bucket.list({ prefix, cursor, limit: 1_000 });
      for (const object of page.objects) {
        const reference = parseObjectKey(vaultId, object.key);
        if (reference) output.push({ ...reference, uploadedAt: object.uploaded.getTime(), size: object.size });
      }
      if (output.length > 100_000) throw new Error("garbage-collection candidate limit exceeded");
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return output;
  }

  async delete(vaultId: string, objects: ReadonlyArray<{ namespace: string | null; objectId: string }>): Promise<void> {
    const keys = objects.map((object) => objectKey(vaultId, object.objectId, object.namespace ?? undefined));
    for (let index = 0; index < keys.length; index += 1_000) await this.#bucket.delete(keys.slice(index, index + 1_000));
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
      SELECT account_id, status, public_exchange_key FROM devices WHERE id = ? LIMIT 1
    `).bind(input.id).first<{ account_id: string; status: DeviceSummary["status"]; public_exchange_key: string | null }>();
    if (existing && (existing.account_id !== principal.accountId || existing.status !== "active")) {
      throw new ControlPlaneError("device-required");
    }
    if (existing?.public_exchange_key && input.publicExchangeKey && existing.public_exchange_key !== input.publicExchangeKey) {
      throw new ControlPlaneError("device-key-conflict");
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
          public_exchange_key = COALESCE(excluded.public_exchange_key, devices.public_exchange_key),
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

  async joinVault(principal: Principal, vaultId: string, keyEpoch = 1): Promise<VaultSummary> {
    await this.#requireDevice(principal);
    const vault = await this.#database.prepare(`
      SELECT id, name, key_epoch FROM vaults WHERE id = ? AND account_id = ? AND status = 'active' LIMIT 1
    `).bind(vaultId, principal.accountId).first<{ id: string; name: string; key_epoch: number }>();
    if (!vault) throw new ControlPlaneError("not-found");
    if (vault.key_epoch !== keyEpoch) throw new RecoveryEpochConflict();

    const existing = await this.#database.prepare(`
      SELECT role FROM vault_members WHERE vault_id = ? AND device_id = ? AND revoked_at IS NULL LIMIT 1
    `).bind(vaultId, principal.deviceId).first<{ role: Exclude<VaultSummary["role"], null> }>();
    if (existing) return { id: vault.id, name: vault.name, role: existing.role };

    const now = Date.now();
    try {
      await this.#database.batch([
        this.#database.prepare(`
          INSERT INTO vault_members (vault_id, device_id, role, created_at, enrolled_key_epoch)
          VALUES (?, ?, 'writer', ?, ?)
          ON CONFLICT(vault_id, device_id) DO UPDATE SET role = vault_members.role, revoked_at = NULL,
            created_at = excluded.created_at, enrolled_key_epoch = excluded.enrolled_key_epoch
        `).bind(vaultId, principal.deviceId, now, keyEpoch),
        auditStatement(this.#database, principal, "vault.join", "vault", vaultId, now),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes("invalid vault enrollment epoch")) throw new RecoveryEpochConflict();
      throw error;
    }
    return { id: vault.id, name: vault.name, role: "writer" };
  }

  async listVaultKeyRecipients(principal: Principal, vaultId: string): Promise<{
    keyEpoch: number;
    devices: Array<{ id: string; publicExchangeKey: string }>;
  }> {
    const vault = await this.#database.prepare(`
      SELECT key_epoch FROM vaults
      WHERE id = ? AND account_id = ? AND status = 'active' LIMIT 1
    `).bind(vaultId, principal.accountId).first<{ key_epoch: number }>();
    if (!vault) throw new ControlPlaneError("not-found");
    const rows = await this.#database.prepare(`
      SELECT d.id, d.public_exchange_key
      FROM vault_members AS vm
      JOIN devices AS d ON d.id = vm.device_id
      WHERE vm.vault_id = ? AND vm.revoked_at IS NULL AND d.status = 'active'
      ORDER BY d.id
    `).bind(vaultId).all<{ id: string; public_exchange_key: string | null }>();
    return {
      keyEpoch: vault.key_epoch,
      devices: rows.results.flatMap((row) => row.public_exchange_key
        ? [{ id: row.id, publicExchangeKey: row.public_exchange_key }]
        : []),
    };
  }

  async vaultKeyEnvelope(principal: Principal, vaultId: string): Promise<{ keyEpoch: number; envelope: string } | null> {
    const row = await this.#database.prepare(`
      SELECT v.key_epoch, envelope.envelope
      FROM vaults AS v
      JOIN vault_members AS vm
        ON vm.vault_id = v.id AND vm.device_id = ? AND vm.revoked_at IS NULL
      JOIN devices AS d
        ON d.id = vm.device_id AND d.account_id = v.account_id AND d.status = 'active'
      LEFT JOIN vault_key_envelopes AS envelope
        ON envelope.vault_id = v.id AND envelope.key_epoch = v.key_epoch AND envelope.device_id = vm.device_id
      WHERE v.id = ? AND v.account_id = ? AND v.status = 'active'
      LIMIT 1
    `).bind(principal.deviceId, vaultId, principal.accountId).first<{ key_epoch: number; envelope: string | null }>();
    return row?.envelope ? { keyEpoch: row.key_epoch, envelope: row.envelope } : null;
  }

  async vaultKeyEnvelopes(principal: Principal, vaultId: string, afterEpoch: number): Promise<{
    keyEpoch: number;
    envelopes: Array<{ keyEpoch: number; envelope: string }>;
  }> {
    const keyEpoch = await this.vaultKeyEpoch(principal, vaultId);
    if (keyEpoch === null) throw new ControlPlaneError("not-found");
    const rows = await this.#database.prepare(`
      SELECT envelope.key_epoch, envelope.envelope
      FROM vault_key_envelopes AS envelope
      JOIN vaults AS v ON v.id = envelope.vault_id
      JOIN vault_members AS vm
        ON vm.vault_id = v.id AND vm.device_id = ? AND vm.revoked_at IS NULL
      JOIN devices AS d
        ON d.id = vm.device_id AND d.account_id = v.account_id AND d.status = 'active'
      WHERE v.id = ? AND v.account_id = ? AND v.status = 'active'
        AND envelope.device_id = vm.device_id AND envelope.key_epoch > ?
      ORDER BY envelope.key_epoch
      LIMIT 1000
    `).bind(principal.deviceId, vaultId, principal.accountId, afterEpoch).all<{ key_epoch: number; envelope: string }>();
    return {
      keyEpoch,
      envelopes: rows.results.map((row) => ({ keyEpoch: row.key_epoch, envelope: row.envelope })),
    };
  }

  async vaultKeyEpoch(principal: Principal, vaultId: string): Promise<number | null> {
    if (principal.capability) {
      if (principal.capability.vaultId !== vaultId) return null;
      const capabilityVault = await this.#database.prepare(`
        SELECT key_epoch FROM vaults
        WHERE id = ? AND account_id = ? AND status = 'active' LIMIT 1
      `).bind(vaultId, principal.accountId).first<{ key_epoch: number }>();
      return capabilityVault?.key_epoch ?? null;
    }
    const row = await this.#database.prepare(`
      SELECT v.key_epoch
      FROM vaults AS v
      JOIN vault_members AS vm
        ON vm.vault_id = v.id AND vm.device_id = ? AND vm.revoked_at IS NULL
      JOIN devices AS d
        ON d.id = vm.device_id AND d.account_id = v.account_id AND d.status = 'active'
      WHERE v.id = ? AND v.account_id = ? AND v.status = 'active'
      LIMIT 1
    `).bind(principal.deviceId, vaultId, principal.accountId).first<{ key_epoch: number }>();
    return row?.key_epoch ?? null;
  }

  async validateVaultKeyRotation(principal: Principal, vaultId: string, input: Parameters<ControlPlane["rotateVaultKey"]>[2]):
    Promise<{ outcome: "stale-epoch" } | { outcome: "recipient-mismatch" } | null> {
    const vault = await this.#database.prepare(`
      SELECT key_epoch FROM vaults
      WHERE id = ? AND account_id = ? AND status = 'active' LIMIT 1
    `).bind(vaultId, principal.accountId).first<{ key_epoch: number }>();
    if (!vault) throw new ControlPlaneError("not-found");
    if (vault.key_epoch !== input.expectedEpoch || input.newEpoch !== input.expectedEpoch + 1) {
      return { outcome: "stale-epoch" };
    }
    const rows = await this.#database.prepare(`
      SELECT d.id, d.public_exchange_key
      FROM vault_members AS vm
      JOIN devices AS d ON d.id = vm.device_id
      WHERE vm.vault_id = ? AND vm.revoked_at IS NULL AND d.status = 'active'
      ORDER BY d.id
    `).bind(vaultId).all<{ id: string; public_exchange_key: string | null }>();
    const activeIds = rows.results.map((row) => row.id).sort((left, right) => left.localeCompare(right, "en"));
    const recipientIds = input.envelopes.map((item) => item.deviceId).sort((left, right) => left.localeCompare(right, "en"));
    if (rows.results.some((row) => !row.public_exchange_key) || activeIds.join("\0") !== recipientIds.join("\0")) {
      return { outcome: "recipient-mismatch" };
    }
    return null;
  }

  async rotateVaultKey(principal: Principal, vaultId: string, input: Parameters<ControlPlane["rotateVaultKey"]>[2]): ReturnType<ControlPlane["rotateVaultKey"]> {
    const rejected = await this.validateVaultKeyRotation(principal, vaultId, input);
    if (rejected) return rejected;

    const now = Date.now();
    try {
      await this.#database.batch([
        ...input.envelopes.map((item) => this.#database.prepare(`
          INSERT INTO vault_key_envelopes (
            vault_id, key_epoch, device_id, envelope, created_by_device_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).bind(vaultId, input.newEpoch, item.deviceId, item.envelope, principal.deviceId, now)),
        this.#database.prepare(`
          UPDATE vaults SET key_epoch = ?
          WHERE id = ? AND account_id = ? AND key_epoch = ? AND status = 'active'
        `).bind(input.newEpoch, vaultId, principal.accountId, input.expectedEpoch),
        this.#database.prepare(`
          UPDATE capability_grants SET revoked_at = COALESCE(revoked_at, ?)
          WHERE vault_id = ? AND account_id = ?
        `).bind(now, vaultId, principal.accountId),
        this.#database.prepare(`
          UPDATE capability_sessions SET revoked_at = COALESCE(revoked_at, ?)
          WHERE grant_id IN (SELECT id FROM capability_grants WHERE vault_id = ? AND account_id = ?)
        `).bind(now, vaultId, principal.accountId),
        auditStatement(this.#database, principal, "vault.key.rotate", "vault", vaultId, now),
      ]);
    } catch (error) {
      // Only a confirmed invariant/uniqueness rejection proves this batch did
      // not commit. A transport/backend failure remains ambiguous to the CLI.
      if (!(error instanceof Error) || !/invalid vault key (?:recipient|issuer|epoch)|incomplete vault key recipients|active device lacks exchange key|UNIQUE constraint failed: vault_key_envelopes/u.test(error.message)) {
        throw error;
      }
      const current = await this.#database.prepare(`
        SELECT key_epoch FROM vaults WHERE id = ? AND account_id = ? LIMIT 1
      `).bind(vaultId, principal.accountId).first<{ key_epoch: number }>();
      return current?.key_epoch !== input.expectedEpoch
        ? { outcome: "stale-epoch" }
        : { outcome: "recipient-mismatch" };
    }
    const updated = await this.#database.prepare(`
      SELECT key_epoch FROM vaults WHERE id = ? AND account_id = ? LIMIT 1
    `).bind(vaultId, principal.accountId).first<{ key_epoch: number }>();
    return updated?.key_epoch === input.newEpoch
      ? { outcome: "rotated", keyEpoch: input.newEpoch }
      : { outcome: "stale-epoch" };
  }

  async listActiveVaultIds(): Promise<string[]> {
    const rows = await this.#database.prepare(`
      SELECT id FROM vaults WHERE status = 'active' ORDER BY id
    `).all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }

  async #requireDevice(principal: Principal): Promise<void> {
    const device = await this.#database.prepare(`
      SELECT id FROM devices WHERE id = ? AND account_id = ? AND status = 'active' LIMIT 1
    `).bind(principal.deviceId, principal.accountId).first<{ id: string }>();
    if (!device) throw new ControlPlaneError("device-required");
  }
}

class CoordinatedControlPlane extends D1ControlPlane {
  constructor(readonly environment: StatecaseEnvironment) {
    super(environment.DB);
  }

  override rotateVaultKey(principal: Principal, vaultId: string, input: Parameters<ControlPlane["rotateVaultKey"]>[2]) {
    return this.environment.VAULTS.getByName(vaultId).rotateVaultKey(principal, vaultId, input);
  }
}

class D1CapabilityService implements CapabilityService {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async create(principal: Principal, input: Parameters<CapabilityService["create"]>[1]): Promise<CapabilitySummary> {
    const now = Date.now();
    try {
      await this.#database.batch([
        this.#database.prepare(`
          INSERT INTO capability_grants (
            id, account_id, creator_device_id, vault_id, token_hash, namespaces_json,
            actions_json, key_envelope, expires_at, created_at, key_epoch
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          input.keyEpoch,
        ),
        auditStatement(this.#database, principal, "capability.create", "capability", input.id, now),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes("invalid capability epoch or issuer")) throw new KeyEpochConflict();
      throw error;
    }
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
    const accessToken = `stc_access_${randomSecret()}`;
    const accessHash = await sha256Base64Url(accessToken);
    const sessionId = `cps_${crypto.randomUUID().replaceAll("-", "")}`;
    const [created] = await this.#database.batch([
      this.#database.prepare(`
        INSERT INTO capability_sessions (id, grant_id, token_hash, expires_at, created_at)
        SELECT ?, id, ?, expires_at, ?
        FROM capability_grants
        WHERE token_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      `).bind(sessionId, accessHash, now, tokenHash, now),
      this.#database.prepare(`
        UPDATE capability_grants SET redeemed_at = ?
        WHERE token_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
          AND EXISTS (SELECT 1 FROM capability_sessions WHERE id = ? AND grant_id = capability_grants.id)
      `).bind(now, tokenHash, now, sessionId),
    ]);
    if (created.meta.changes !== 1) return null;
    const grant = await this.#database.prepare(`
      SELECT cg.id, cg.vault_id, cg.namespaces_json, cg.actions_json, cg.key_envelope, cg.expires_at
      FROM capability_grants cg
      INNER JOIN capability_sessions cs ON cs.grant_id = cg.id
      WHERE cs.id = ? AND cg.redeemed_at = ? LIMIT 1
    `).bind(sessionId, now).first<CapabilityRedeemRow>();
    if (!grant) throw new Error("capability redemption transaction lost its grant");
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

function parseObjectKey(vaultId: string, key: string): { namespace: string | null; objectId: string } | undefined {
  const escapedVault = escapeRegularExpression(vaultId);
  const legacy = new RegExp(`^v1/vaults/${escapedVault}/objects/([^/]+)/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})$`, "u").exec(key);
  if (legacy) return legacy[1] === legacy[2]!.slice(0, 12) ? { namespace: null, objectId: legacy[2]! } : undefined;
  const scoped = new RegExp(`^v1/vaults/${escapedVault}/namespaces/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})/objects/([^/]+)/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})$`, "u").exec(key);
  return scoped && scoped[2] === scoped[3]!.slice(0, 12)
    ? { namespace: scoped[1]!, objectId: scoped[3]! }
    : undefined;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
