import type { CommitRequest, ScopedCommitRequest } from "@statecase/protocol";

export class RemoteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "RemoteError";
  }
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface VaultRecord {
  id: string;
  name?: string;
  role: "owner" | "writer" | "reader" | "append" | null;
}

export interface RemoteHead {
  revisionId: string | null;
  manifestObjectId: string | null;
}

export interface RemoteNamespaceHead {
  namespace: string;
  revisionId: string;
  manifestObjectId: string;
  keyEpoch?: number;
  commitMode?: "replace" | "append";
}

export interface RemoteNamespaceRevision extends RemoteNamespaceHead {
  previousRevisionId: string | null;
}

export interface RemoteNamespaceHeads {
  revisionId: string | null;
  namespaces: RemoteNamespaceHead[];
  commitProvenance?: 1;
}

export interface RemoteScopedRevision extends RemoteNamespaceHeads {
  revisionId: string;
  previousRevisionId: string | null;
}

export interface CapabilityRecord {
  id: string;
  vaultId: string;
  namespaces: string[];
  actions: Array<"read" | "append">;
  expiresAt: number;
  redeemedAt?: number;
  revokedAt?: number;
  createdAt: number;
}

export interface CreateCapabilityInput {
  id: string;
  vaultId: string;
  keyEpoch: number;
  tokenHash: string;
  namespaces: string[];
  actions: Array<"read" | "append">;
  expiresAt: number;
  keyEnvelope: string;
}

export interface BootstrapRedemption {
  accessToken: string;
  expiresAt: number;
  vaultId: string;
  namespaces: string[];
  actions: Array<"read" | "append">;
  keyEnvelope: string;
}

export interface RemoteRevision extends RemoteHead {
  revisionId: string;
  manifestObjectId: string;
  previousRevisionId: string | null;
}

export interface RemoteSnapshot {
  id: string;
  name: string;
  revisionId: string;
  manifestObjectId?: string;
  protocolVersion?: "1.1";
  protected: true;
  createdAt: number;
}

export interface RemoteGarbageCollection {
  outcome: "completed";
  id: string;
  dryRun: boolean;
  candidateObjects: number;
  deletedObjects: number;
  deleteBytes: number;
  checkpoints: number;
  conservativeScopes: string[];
  trackedSince: number | null;
}

export interface DeviceRecord {
  id: string;
  name: string;
  status: "active" | "revoked";
  createdAt?: number;
  lastSeenAt?: number;
}

export interface VaultKeyRecipientsRecord {
  keyEpoch: number;
  devices: Array<{ id: string; publicExchangeKey: string }>;
}

export class StatecaseClient {
  readonly #baseUrl: string;
  readonly #token?: string;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, token?: string, fetchImplementation: typeof fetch = fetch) {
    this.#baseUrl = baseUrl.replace(/\/+$/u, "");
    this.#token = token;
    this.#fetch = fetchImplementation;
  }

  startDeviceCode(): Promise<DeviceCodeResponse> {
    return this.#json("/api/auth/device/code", {
      method: "POST",
      body: JSON.stringify({ client_id: "statecase-cli", scope: "sync" }),
    });
  }

  pollDeviceCode(deviceCode: string): Promise<{ access_token: string }> {
    return this.#json("/api/auth/device/token", {
      method: "POST",
      body: JSON.stringify({
        client_id: "statecase-cli",
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
  }

  registerDevice(input: { id: string; name: string; publicExchangeKey: string }): Promise<{ accountId: string; deviceId: string; name: string }> {
    return this.#json("/v1/devices/current", { method: "POST", body: JSON.stringify(input) });
  }

  async listDevices(): Promise<DeviceRecord[]> {
    return (await this.#json<{ devices: DeviceRecord[] }>("/v1/devices")).devices;
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.#request(`/v1/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
  }

  createVault(name: string): Promise<VaultRecord> {
    return this.#json("/v1/vaults", { method: "POST", body: JSON.stringify({ name }) });
  }

  async listVaults(): Promise<VaultRecord[]> {
    return (await this.#json<{ vaults: VaultRecord[] }>("/v1/vaults")).vaults;
  }

  joinVault(vaultId: string, keyEpoch = 1): Promise<VaultRecord> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/join`, { method: "POST", body: JSON.stringify({ keyEpoch }) });
  }

  vaultKeyRecipients(vaultId: string): Promise<VaultKeyRecipientsRecord> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/key-recipients`);
  }

  vaultKeyEnvelope(vaultId: string): Promise<{ keyEpoch: number; envelope: string }> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/key-envelope`);
  }

  vaultKeyEnvelopes(vaultId: string, afterEpoch: number): Promise<{
    keyEpoch: number;
    envelopes: Array<{ keyEpoch: number; envelope: string }>;
  }> {
    return this.#json(
      `/v1/vaults/${encodeURIComponent(vaultId)}/key-envelopes?afterEpoch=${afterEpoch}`,
    );
  }

  rotateVaultKey(vaultId: string, input: {
    expectedEpoch: number;
    newEpoch: number;
    envelopes: Array<{ deviceId: string; envelope: string }>;
  }): Promise<{ keyEpoch: number; rotated: true }> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/key-rotations`, { method: "POST", body: JSON.stringify(input) });
  }

  head(vaultId: string): Promise<RemoteHead> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/head`);
  }

  namespaceHeads(vaultId: string): Promise<RemoteNamespaceHeads> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/namespaces`);
  }

  namespaceRevision(vaultId: string, namespace: string, revisionId: string): Promise<RemoteNamespaceRevision> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/namespaces/${encodeURIComponent(namespace)}/revisions/${encodeURIComponent(revisionId)}`);
  }

  scopedRevision(vaultId: string, revisionId: string): Promise<RemoteScopedRevision> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/scoped-revisions/${encodeURIComponent(revisionId)}`);
  }

  revision(vaultId: string, revisionId: string): Promise<RemoteRevision> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/revisions/${encodeURIComponent(revisionId)}`);
  }

  createSnapshot(vaultId: string, name: string, snapshotId = `snp_${crypto.randomUUID().replaceAll("-", "")}`): Promise<RemoteSnapshot> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/snapshots`, {
      method: "POST",
      body: JSON.stringify({ id: snapshotId, name }),
    });
  }

  async listSnapshots(vaultId: string): Promise<RemoteSnapshot[]> {
    return (await this.#json<{ snapshots: RemoteSnapshot[] }>(`/v1/vaults/${encodeURIComponent(vaultId)}/snapshots`)).snapshots;
  }

  async deleteSnapshot(vaultId: string, snapshotId: string): Promise<void> {
    await this.#request(`/v1/vaults/${encodeURIComponent(vaultId)}/snapshots/${encodeURIComponent(snapshotId)}`, { method: "DELETE" });
  }

  garbageCollect(vaultId: string, dryRun: boolean): Promise<RemoteGarbageCollection> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/garbage-collection`, {
      method: "POST",
      body: JSON.stringify({ dryRun }),
    });
  }

  async putObject(vaultId: string, objectId: string, bytes: Uint8Array): Promise<void> {
    await this.#request(`/v1/vaults/${encodeURIComponent(vaultId)}/objects/${encodeURIComponent(objectId)}`, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  async getObject(vaultId: string, objectId: string): Promise<Uint8Array> {
    const response = await this.#request(`/v1/vaults/${encodeURIComponent(vaultId)}/objects/${encodeURIComponent(objectId)}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async putNamespaceObject(vaultId: string, namespace: string, objectId: string, bytes: Uint8Array): Promise<void> {
    await this.#request(`/v1/vaults/${encodeURIComponent(vaultId)}/namespaces/${encodeURIComponent(namespace)}/objects/${encodeURIComponent(objectId)}`, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  async getNamespaceObject(vaultId: string, namespace: string, objectId: string): Promise<Uint8Array> {
    const response = await this.#request(`/v1/vaults/${encodeURIComponent(vaultId)}/namespaces/${encodeURIComponent(namespace)}/objects/${encodeURIComponent(objectId)}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  commit(vaultId: string, request: CommitRequest): Promise<{ outcome: string; revisionId: string }> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/commits`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  commitNamespaces(vaultId: string, request: ScopedCommitRequest): Promise<{ outcome: string; revisionId: string }> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/namespace-commits`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  createCapability(input: CreateCapabilityInput): Promise<CapabilityRecord> {
    return this.#json("/v1/tokens", { method: "POST", body: JSON.stringify(input) });
  }

  async listCapabilities(): Promise<CapabilityRecord[]> {
    return (await this.#json<{ tokens: CapabilityRecord[] }>("/v1/tokens")).tokens;
  }

  async revokeCapability(capabilityId: string): Promise<void> {
    await this.#request(`/v1/tokens/${encodeURIComponent(capabilityId)}`, { method: "DELETE" });
  }

  redeemBootstrap(token: string): Promise<BootstrapRedemption> {
    return this.#json("/api/bootstrap/redeem", { method: "POST", body: JSON.stringify({ token }) });
  }

  async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#request(path, init);
    try {
      return await response.json() as T;
    } catch {
      throw new RemoteError(response.status, "INVALID_RESPONSE", "service returned an invalid response");
    }
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type") && init.body !== undefined) headers.set("content-type", "application/json");
    if (this.#token) headers.set("authorization", `Bearer ${this.#token}`);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, { ...init, headers });
    } catch {
      throw new RemoteError(0, "NETWORK_ERROR", "Statecase service is unavailable");
    }
    if (response.ok) return response;
    const body = await response.json().catch(() => ({})) as { error?: string | { code?: string; message?: string }; error_description?: string };
    const code = typeof body.error === "object" ? body.error.code : body.error;
    const message = typeof body.error === "object" ? body.error.message : body.error_description;
    throw new RemoteError(response.status, code ?? "REMOTE_ERROR", message ?? "Statecase request failed");
  }
}
