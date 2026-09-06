import type { CommitRequest } from "@statecase/protocol";

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

export interface DeviceRecord {
  id: string;
  name: string;
  status: "active" | "revoked";
  createdAt?: number;
  lastSeenAt?: number;
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

  registerDevice(input: { id: string; name: string }): Promise<{ accountId: string; deviceId: string; name: string }> {
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

  joinVault(vaultId: string): Promise<VaultRecord> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/join`, { method: "POST" });
  }

  head(vaultId: string): Promise<RemoteHead> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/head`);
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

  commit(vaultId: string, request: CommitRequest): Promise<{ outcome: string; revisionId: string }> {
    return this.#json(`/v1/vaults/${encodeURIComponent(vaultId)}/commits`, {
      method: "POST",
      body: JSON.stringify(request),
    });
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
