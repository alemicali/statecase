import { describe, expect, it } from "vitest";

import { InMemoryCoordinatorStorage, VaultCoordinatorCore } from "@statecase/sync-core";

import {
  ControlPlaneError,
  createCloudApp,
  type AuthService,
  type CloudServices,
  type ControlPlane,
  type ObjectStore,
  type Principal,
} from "../src/app.js";

const principal: Principal = { accountId: "acct_01", sessionId: "ses_01", deviceId: "dev_01", scopes: ["sync"] };

function fixture(options: { authenticated?: boolean; authorized?: boolean; adminAuthorized?: boolean } = {}) {
  const objects = new MemoryObjects();
  const coordinators = new Map<string, VaultCoordinatorCore>();
  const auth: AuthService = {
    handle: async () => new Response("auth-route", { status: 207 }),
    authenticate: async () => options.authenticated === false ? null : principal,
  };
  const services: CloudServices = {
    auth,
    objects,
    authorizeVault: async (_principalValue, _vaultId, action) => options.authorized !== false && (action !== "admin" || options.adminAuthorized !== false),
    coordinator: (vaultId) => {
      let coordinator = coordinators.get(vaultId);
      if (!coordinator) {
        coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
        coordinators.set(vaultId, coordinator);
      }
      return coordinator;
    },
    control: new MemoryControl(),
  };
  return { app: createCloudApp(services), objects };
}

describe("Cloud API contract (PR-001..PR-015)", () => {
  it("exposes unauthenticated health without payload detail", async () => {
    const response = await fixture({ authenticated: false }).app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ protocolVersion: "1.0", service: "statecase", status: "ok" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("mounts the auth service before protected routes", async () => {
    const response = await fixture().app.request("/api/auth/demo");
    expect(response.status).toBe(207);
    expect(await response.text()).toBe("auth-route");
  });

  it("serves a self-contained login/device approval shell with external assets", async () => {
    const { app } = fixture();
    const page = await app.request("/device?user_code=ABCD-2345");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Take your agents");
    expect(html).toContain("anywhere.</em>");
    expect(html).toContain('/ui.js');
    expect(html).not.toContain("<script>");
    expect((await app.request("/ui.css")).headers.get("content-type")).toContain("text/css");
    expect((await app.request("/ui.js")).headers.get("content-type")).toContain("javascript");
  });

  it("returns 401 when no bearer/session identity exists", async () => {
    const response = await fixture({ authenticated: false }).app.request("/v1/vaults/vlt_01/head");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });

  it("uses not-found semantics for unauthorized vaults", async () => {
    const response = await fixture({ authorized: false }).app.request("/v1/vaults/vlt_other/head");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("registers the current device and manages account vaults", async () => {
    const { app } = fixture();
    const registered = await app.request("/v1/devices/current", {
      method: "POST",
      body: JSON.stringify({ id: "dev_01", name: "Test laptop", publicSigningKey: "sign", publicExchangeKey: "exchange" }),
    });
    expect(registered.status).toBe(200);
    expect(await registered.json()).toEqual({ accountId: "acct_01", deviceId: "dev_01", name: "Test laptop" });

    const created = await app.request("/v1/vaults", { method: "POST", body: JSON.stringify({ name: "Personal" }) });
    expect(created.status).toBe(201);
    const vault = await created.json() as { id: string; name: string };
    expect(vault).toMatchObject({ id: "vlt_test", name: "Personal", role: "owner" });
    expect(await (await app.request("/v1/vaults")).json()).toEqual({ vaults: [vault] });
    expect((await app.request(`/v1/vaults/${vault.id}/join`, { method: "POST" })).status).toBe(200);
  });

  it("lists and revokes account devices without leaking unknown IDs (AU-008, AU-009)", async () => {
    const { app } = fixture();
    await app.request("/v1/devices/current", { method: "POST", body: JSON.stringify({ id: "dev_01", name: "Laptop" }) });
    const listed = await app.request("/v1/devices");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ devices: [
      { id: "dev_01", name: "Laptop", status: "active" },
      { id: "dev_old", name: "Old laptop", status: "active" },
    ] });

    expect((await app.request("/v1/devices/dev_unknown", { method: "DELETE" })).status).toBe(404);
    const revoked = await app.request("/v1/devices/dev_old", { method: "DELETE" });
    expect(revoked.status).toBe(204);
    expect(await (await app.request("/v1/devices")).json()).toEqual({ devices: [
      { id: "dev_01", name: "Laptop", status: "active" },
      { id: "dev_old", name: "Old laptop", status: "revoked" },
    ] });
  });

  it("rejects invalid device and vault control payloads", async () => {
    const { app } = fixture();
    expect((await app.request("/v1/devices/current", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await app.request("/v1/devices/current", { method: "POST", body: JSON.stringify({ id: "bad id", name: "Invalid" }) })).status).toBe(400);
    expect((await app.request("/v1/vaults", { method: "POST", body: "{}" })).status).toBe(400);
  });

  it("streams immutable objects and treats a duplicate as success", async () => {
    const { app, objects } = fixture();
    const url = "/v1/vaults/vlt_01/objects/obj_abc";
    const first = await app.request(url, { method: "PUT", body: Uint8Array.of(1, 2, 3) });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ created: true, objectId: "obj_abc", size: 3 });
    const duplicate = await app.request(url, { method: "PUT", body: Uint8Array.of(9, 9) });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ created: false, objectId: "obj_abc", size: 3 });
    expect(objects.bytes("vlt_01", "obj_abc")).toEqual(Uint8Array.of(1, 2, 3));

    const download = await app.request(url);
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
    expect(download.headers.get("cache-control")).toContain("immutable");
  });

  it("returns not found for an absent object", async () => {
    const response = await fixture().app.request("/v1/vaults/vlt_01/objects/obj_absent");
    expect(response.status).toBe(404);
  });

  it("rejects declared oversized uploads before reading the body", async () => {
    const response = await fixture().app.request("/v1/vaults/vlt_01/objects/obj_large", {
      method: "PUT",
      headers: { "content-length": String(8 * 1024 * 1024 + 1) },
      body: Uint8Array.of(1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("commits only after every encrypted object exists", async () => {
    const { app } = fixture();
    const request = commit("op_01", null, "rev_01", "obj_manifest", ["obj_chunk"]);
    const missing = await app.request("/v1/vaults/vlt_01/commits", { method: "POST", body: JSON.stringify(request) });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: { code: "OBJECT_MISSING", message: "one or more encrypted objects are missing" } });

    for (const objectId of ["obj_manifest", "obj_chunk"]) {
      await app.request(`/v1/vaults/vlt_01/objects/${objectId}`, { method: "PUT", body: Uint8Array.of(1) });
    }
    const committed = await app.request("/v1/vaults/vlt_01/commits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ outcome: "committed", revisionId: "rev_01" });
    expect(await (await app.request("/v1/vaults/vlt_01/head")).json()).toEqual({
      revisionId: "rev_01",
      manifestObjectId: "obj_manifest",
    });
  });

  it("preserves idempotency and structured stale-base errors", async () => {
    const { app } = fixture();
    for (const objectId of ["obj_manifest", "obj_chunk", "obj_manifest_2"]) {
      await app.request(`/v1/vaults/vlt_01/objects/${objectId}`, { method: "PUT", body: Uint8Array.of(1) });
    }
    const first = commit("op_01", null, "rev_01", "obj_manifest", ["obj_chunk"]);
    await app.request("/v1/vaults/vlt_01/commits", { method: "POST", body: JSON.stringify(first) });
    expect((await app.request("/v1/vaults/vlt_01/commits", { method: "POST", body: JSON.stringify(first) })).status).toBe(200);
    const reused = await app.request("/v1/vaults/vlt_01/commits", {
      method: "POST",
      body: JSON.stringify({ ...first, revisionId: "rev_other" }),
    });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });

    const stale = await app.request("/v1/vaults/vlt_01/commits", {
      method: "POST",
      body: JSON.stringify(commit("op_02", null, "rev_02", "obj_manifest_2", [])),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: { code: "STALE_BASE", currentRevisionId: "rev_01", message: "vault head advanced" },
    });
  });

  it("creates, lists, resolves, and explicitly deletes protected snapshots (BK-001, BK-003)", async () => {
    const { app } = fixture();
    await app.request("/v1/vaults/vlt_01/objects/obj_manifest", { method: "PUT", body: Uint8Array.of(1) });
    await app.request("/v1/vaults/vlt_01/commits", {
      method: "POST",
      body: JSON.stringify(commit("op_snapshot", null, "rev_snapshot", "obj_manifest", [])),
    });
    const created = await app.request("/v1/vaults/vlt_01/snapshots", {
      method: "POST",
      body: JSON.stringify({ id: "snp_api", name: "Before cleanup" }),
    });
    expect(created.status).toBe(201);
    const snapshot = await created.json() as { id: string; revisionId: string; protected: boolean };
    expect(snapshot).toMatchObject({ id: "snp_api", revisionId: "rev_snapshot", protected: true });
    const replay = await app.request("/v1/vaults/vlt_01/snapshots", {
      method: "POST",
      body: JSON.stringify({ id: "snp_api", name: "Before cleanup" }),
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(snapshot);
    expect(await (await app.request("/v1/vaults/vlt_01/snapshots")).json()).toEqual({ snapshots: [snapshot] });
    expect(await (await app.request("/v1/vaults/vlt_01/revisions/rev_snapshot")).json()).toMatchObject({ manifestObjectId: "obj_manifest" });
    expect((await app.request("/v1/vaults/vlt_01/revisions/rev_unknown")).status).toBe(404);
    expect((await app.request(`/v1/vaults/vlt_01/snapshots/${snapshot.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await (await app.request("/v1/vaults/vlt_01/snapshots")).json()).toEqual({ snapshots: [] });
  });

  it("requires a writable head to snapshot and owner authority to delete protection", async () => {
    const empty = fixture().app;
    expect((await empty.request("/v1/vaults/vlt_01/snapshots", {
      method: "POST",
      body: JSON.stringify({ id: "snp_empty", name: "Empty" }),
    })).status).toBe(409);
    expect((await empty.request("/v1/vaults/vlt_01/snapshots", { method: "POST", body: "{}" })).status).toBe(400);

    const nonOwner = fixture({ adminAuthorized: false }).app;
    expect((await nonOwner.request("/v1/vaults/vlt_01/snapshots/snp_hidden", { method: "DELETE" })).status).toBe(404);
  });

  it.each(["not-json", JSON.stringify({ protocolVersion: "9.0" })])("rejects invalid commit body", async (body) => {
    const response = await fixture().app.request("/v1/vaults/vlt_01/commits", { method: "POST", body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("returns a uniform route-not-found payload", async () => {
    const response = await fixture().app.request("/does-not-exist");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

function commit(operationId: string, baseRevisionId: string | null, revisionId: string, manifestObjectId: string, requiredObjectIds: string[]) {
  return { protocolVersion: "1.0", operationId, baseRevisionId, revisionId, manifestObjectId, requiredObjectIds };
}

class MemoryObjects implements ObjectStore {
  readonly #values = new Map<string, Uint8Array>();

  async putIfAbsent(vaultId: string, objectId: string, body: ReadableStream<Uint8Array>): Promise<{ created: boolean; size: number }> {
    const key = `${vaultId}/${objectId}`;
    const existing = this.#values.get(key);
    if (existing) return { created: false, size: existing.byteLength };
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.#values.set(key, bytes);
    return { created: true, size: bytes.byteLength };
  }

  async get(vaultId: string, objectId: string): Promise<Uint8Array | null> {
    return this.#values.get(`${vaultId}/${objectId}`) ?? null;
  }

  async exists(vaultId: string, objectId: string): Promise<boolean> {
    return this.#values.has(`${vaultId}/${objectId}`);
  }

  bytes(vaultId: string, objectId: string): Uint8Array | undefined {
    return this.#values.get(`${vaultId}/${objectId}`);
  }
}

class MemoryControl implements ControlPlane {
  readonly #vaults: Array<{ id: string; name: string; role: "owner" }> = [];
  readonly #devices = new Map<string, { id: string; name: string; status: "active" | "revoked" }>([
    ["dev_old", { id: "dev_old", name: "Old laptop", status: "active" }],
  ]);

  async registerDevice(principalValue: Principal, input: { id: string; name: string }): Promise<{ accountId: string; deviceId: string; name: string }> {
    this.#devices.set(input.id, { id: input.id, name: input.name, status: "active" });
    return { accountId: principalValue.accountId, deviceId: input.id, name: input.name };
  }

  async listDevices(): Promise<Array<{ id: string; name: string; status: "active" | "revoked" }>> {
    return [...this.#devices.values()].sort((left, right) => left.id.localeCompare(right.id, "en"));
  }

  async revokeDevice(_principalValue: Principal, deviceId: string): Promise<void> {
    const device = this.#devices.get(deviceId);
    if (!device) throw new ControlPlaneError("not-found");
    device.status = "revoked";
  }

  async createVault(_principalValue: Principal, input: { name: string }): Promise<{ id: string; name: string; role: "owner" }> {
    const vault = { id: "vlt_test", name: input.name, role: "owner" as const };
    this.#vaults.push(vault);
    return vault;
  }

  async listVaults(): Promise<Array<{ id: string; name: string; role: "owner" }>> {
    return this.#vaults;
  }

  async joinVault(_principalValue: Principal, vaultId: string): Promise<{ id: string; role: "owner" }> {
    return { id: vaultId, role: "owner" };
  }
}
