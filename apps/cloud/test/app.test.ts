import { describe, expect, it, vi } from "vitest";

import { InMemoryCoordinatorStorage, VaultCoordinatorCore } from "@statecase/sync-core";

import {
  ControlPlaneError,
  RecoveryEpochConflict,
  createCloudApp,
  runScheduledGarbageCollection,
  type AuthService,
  type CapabilityService,
  type CloudServices,
  type ControlPlane,
  type ObjectStore,
  type Principal,
} from "../src/app.js";

const principal: Principal = { accountId: "acct_01", sessionId: "ses_01", deviceId: "dev_01", scopes: ["sync"] };

function fixture(options: { authenticated?: boolean; authorized?: boolean; adminAuthorized?: boolean; namespace?: string } = {}) {
  const objects = new MemoryObjects();
  const coordinators = new Map<string, VaultCoordinatorCore>();
  const auth: AuthService = {
    handle: async () => new Response("auth-route", { status: 207 }),
    authenticate: async () => options.authenticated === false ? null : principal,
  };
  const control = new MemoryControl();
  const services: CloudServices = {
    auth,
    objects,
    authorizeVault: async (_principalValue, _vaultId, action) => options.authorized !== false && (action !== "admin" || options.adminAuthorized !== false),
    authorizeNamespace: async (_principalValue, _vaultId, namespace) =>
      options.authorized !== false && (!options.namespace || options.namespace === namespace),
    coordinator: (vaultId) => {
      let coordinator = coordinators.get(vaultId);
      if (!coordinator) {
        coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
        coordinators.set(vaultId, coordinator);
      }
      return {
        head: () => coordinator.head(),
        revision: (id) => coordinator.revision(id),
        commit: (request) => coordinator.commit(request),
        listSnapshots: () => coordinator.listSnapshots(),
        createSnapshot: (input) => coordinator.createSnapshot(input),
        deleteSnapshot: (id) => coordinator.deleteSnapshot(id),
        namespaceHeads: (allowed) => coordinator.namespaceHeads(allowed),
        namespaceRevision: (namespace, id) => coordinator.namespaceRevision(namespace, id),
        scopedHead: () => coordinator.scopedHead(),
        commitNamespaces: (request) => coordinator.commitNamespaces(request),
        scopedRevision: (id) => coordinator.scopedRevision(id),
        planGarbageCollection: (input) => coordinator.planGarbageCollection(input),
        finalizeGarbageCollection: (id) => coordinator.finalizeGarbageCollection(id),
      };
    },
    control,
    capabilities: new MemoryCapabilities(),
  };
  return { app: createCloudApp(services), objects, services, control };
}

describe("Cloud API contract (PR-001..PR-015)", () => {
  it("exposes unauthenticated health without payload detail", async () => {
    const response = await fixture({ authenticated: false }).app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ protocolVersion: "1.1", legacyProtocolVersion: "1.0", service: "statecase", status: "ok" });
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
    expect((await fixture({ authorized: false }).app.request("/v1/vaults/vlt_other/key-envelope")).status).toBe(404);
    expect((await fixture({ authorized: false }).app.request("/v1/vaults/vlt_other/key-envelopes?afterEpoch=0")).status).toBe(404);
    expect((await fixture({ adminAuthorized: false }).app.request("/v1/vaults/vlt_other/key-recipients")).status).toBe(404);
    expect((await fixture({ adminAuthorized: false }).app.request("/v1/vaults/vlt_other/key-rotations", {
      method: "POST",
      body: JSON.stringify({ expectedEpoch: 1, newEpoch: 2, envelopes: [{ deviceId: "dev_01", envelope: "opaque" }] }),
    })).status).toBe(404);
  });

  it("registers the current device and manages account vaults", async () => {
    const { app } = fixture();
    expect((await app.request("/v1/devices/current", {
      method: "POST",
      body: JSON.stringify({ id: "dev_bad", name: "Invalid exchange key", publicExchangeKey: "exchange" }),
    })).status).toBe(400);
    const registered = await app.request("/v1/devices/current", {
      method: "POST",
      body: JSON.stringify({ id: "dev_01", name: "Test laptop", publicSigningKey: "sign", publicExchangeKey: `stc_x25519_public_v1.${"a".repeat(43)}` }),
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

  it("validates enrollment epochs and reports stale recovery before membership mutation (CR-010, AU-008)", async () => {
    const { app, services } = fixture();
    const join = vi.fn(async (_principal: Principal, id: string, epoch = 1) => {
      if (epoch !== 2) throw new RecoveryEpochConflict();
      return { id, role: "writer" as const };
    });
    services.control.joinVault = join;
    for (const body of ["{", "null", '{"keyEpoch":0}', '{"keyEpoch":1.5}', '{"unknown":1}']) {
      expect((await app.request("/v1/vaults/vlt_test/join", { method: "POST", body })).status).toBe(400);
    }
    expect(join).not.toHaveBeenCalled();
    const stale = await app.request("/v1/vaults/vlt_test/join", { method: "POST" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "KEY_EPOCH_CONFLICT" } });
    expect((await app.request("/v1/vaults/vlt_test/join", { method: "POST", body: JSON.stringify({ keyEpoch: 2 }) })).status).toBe(200);
    expect(join).toHaveBeenLastCalledWith(principal, "vlt_test", 2);
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

  it("rotates a vault key epoch only for the exact active-device set (CR-010, AU-008)", async () => {
    const { app, control } = fixture();
    await app.request("/v1/devices/current", {
      method: "POST",
      body: JSON.stringify({ id: "dev_01", name: "Laptop", publicExchangeKey: `stc_x25519_public_v1.${"a".repeat(43)}` }),
    });
    const created = await app.request("/v1/vaults", { method: "POST", body: JSON.stringify({ name: "Personal" }) });
    const vault = await created.json() as { id: string };
    control.addVaultDevice(vault.id, { id: "dev_old", publicExchangeKey: `stc_x25519_public_v1.${"b".repeat(43)}` });

    const recipients = await app.request(`/v1/vaults/${vault.id}/key-recipients`);
    expect(recipients.status).toBe(200);
    expect(await recipients.json()).toEqual({
      keyEpoch: 1,
      devices: [
        { id: "dev_01", publicExchangeKey: `stc_x25519_public_v1.${"a".repeat(43)}` },
        { id: "dev_old", publicExchangeKey: `stc_x25519_public_v1.${"b".repeat(43)}` },
      ],
    });

    const incomplete = await app.request(`/v1/vaults/${vault.id}/key-rotations`, {
      method: "POST",
      body: JSON.stringify({ expectedEpoch: 1, newEpoch: 2, envelopes: [{ deviceId: "dev_01", envelope: "sealed-for-current" }] }),
    });
    expect(incomplete.status).toBe(409);
    expect(await incomplete.json()).toMatchObject({ error: { code: "KEY_RECIPIENT_MISMATCH" } });

    const rotated = await app.request(`/v1/vaults/${vault.id}/key-rotations`, {
      method: "POST",
      body: JSON.stringify({
        expectedEpoch: 1,
        newEpoch: 2,
        envelopes: [
          { deviceId: "dev_01", envelope: "sealed-for-current" },
          { deviceId: "dev_old", envelope: "sealed-for-old" },
        ],
      }),
    });
    expect(rotated.status).toBe(201);
    expect(await rotated.json()).toEqual({ keyEpoch: 2, rotated: true });

    const envelope = await app.request(`/v1/vaults/${vault.id}/key-envelope`);
    expect(envelope.status).toBe(200);
    expect(envelope.headers.get("cache-control")).toBe("no-store");
    expect(await envelope.json()).toEqual({ keyEpoch: 2, envelope: "sealed-for-current" });
    expect(await (await app.request(`/v1/vaults/${vault.id}/key-envelopes?afterEpoch=1`)).json()).toEqual({
      keyEpoch: 2,
      envelopes: [{ keyEpoch: 2, envelope: "sealed-for-current" }],
    });
    expect((await app.request(`/v1/vaults/${vault.id}/key-envelopes?afterEpoch=-1`)).status).toBe(400);

    const duplicate = await app.request(`/v1/vaults/${vault.id}/key-rotations`, {
      method: "POST",
      body: JSON.stringify({ expectedEpoch: 2, newEpoch: 3, envelopes: [
        { deviceId: "dev_01", envelope: "first" },
        { deviceId: "dev_01", envelope: "duplicate" },
      ] }),
    });
    expect(duplicate.status).toBe(400);

    const stale = await app.request(`/v1/vaults/${vault.id}/key-rotations`, {
      method: "POST",
      body: JSON.stringify({ expectedEpoch: 1, newEpoch: 2, envelopes: [
        { deviceId: "dev_01", envelope: "replacement" },
        { deviceId: "dev_old", envelope: "replacement" },
      ] }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "KEY_EPOCH_CONFLICT" } });

    const objectBase = `/v1/vaults/${vault.id}/namespaces/drop%3Arotated/objects`;
    await app.request(`${objectBase}/obj_manifest`, { method: "PUT", body: Uint8Array.of(1) });
    await app.request(`${objectBase}/obj_chunk`, { method: "PUT", body: Uint8Array.of(2) });
    const oldEpochBase = scopedCommit("op_old_epoch", "srev_old_epoch", "drop:rotated", null, "nrev_old_epoch", "replace", "pth_old");
    const oldEpoch = { ...oldEpochBase, updates: [{ ...oldEpochBase.updates[0]!, keyEpoch: 1 }] };
    const rejectedCommit = await app.request(`/v1/vaults/${vault.id}/namespace-commits`, {
      method: "POST", body: JSON.stringify(oldEpoch),
    });
    expect(rejectedCommit.status).toBe(409);
    expect(await rejectedCommit.json()).toMatchObject({ error: { code: "KEY_EPOCH_CONFLICT" } });
    const rejectedLegacy = await app.request(`/v1/vaults/${vault.id}/commits`, {
      method: "POST",
      body: JSON.stringify(commit("op_legacy_after_rotation", null, "rev_legacy_after_rotation", "obj_manifest", ["obj_chunk"])),
    });
    expect(rejectedLegacy.status).toBe(409);
    expect(await rejectedLegacy.json()).toMatchObject({ error: { code: "KEY_EPOCH_CONFLICT" } });
    const currentEpoch = { ...oldEpoch, operationId: "op_new_epoch", vaultRevisionId: "srev_new_epoch", updates: [
      { ...oldEpoch.updates[0]!, namespaceRevisionId: "nrev_new_epoch", keyEpoch: 2 },
    ] };
    expect((await app.request(`/v1/vaults/${vault.id}/namespace-commits`, {
      method: "POST", body: JSON.stringify(currentEpoch),
    })).status).toBe(200);
  });

  it("creates, lists, redeems once, and revokes redacted ephemeral capabilities (AU-003..AU-007)", async () => {
    const { app } = fixture();
    const token = `stc_boot_${"a".repeat(43)}`;
    const created = await app.request("/v1/tokens", {
      method: "POST",
      body: JSON.stringify({
        id: "cap_01",
        vaultId: "vlt_01",
        keyEpoch: 1,
        tokenHash: await sha256(token),
        namespaces: ["workspace:ws_01", "harness:codex:sandbox"],
        actions: ["read", "append"],
        expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        keyEnvelope: "opaque-client-encrypted-scope-keys",
      }),
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(await created.json())).not.toContain(token);
    const listed = await (await app.request("/v1/tokens")).json() as { tokens: unknown[] };
    expect(listed.tokens).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("tokenHash");
    expect(JSON.stringify(listed)).not.toContain("keyEnvelope");

    const redeemed = await app.request("/api/bootstrap/redeem", { method: "POST", body: JSON.stringify({ token }) });
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.get("cache-control")).toBe("no-store");
    expect(await redeemed.json()).toMatchObject({
      accessToken: expect.stringMatching(/^stc_access_/u),
      vaultId: "vlt_01",
      namespaces: ["workspace:ws_01", "harness:codex:sandbox"],
      actions: ["read", "append"],
      keyEnvelope: "opaque-client-encrypted-scope-keys",
    });
    const replay = await app.request("/api/bootstrap/redeem", { method: "POST", body: JSON.stringify({ token }) });
    expect(replay.status).toBe(401);
    expect(replay.headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/v1/tokens/cap_01", { method: "DELETE" })).status).toBe(204);
    expect(await (await app.request("/v1/tokens")).json()).toMatchObject({ tokens: [{ id: "cap_01", revokedAt: expect.any(Number) }] });
  });

  it("rejects overlong, secret-bearing, duplicate, and unauthorized capability grants", async () => {
    const valid = {
      id: "cap_invalid",
      vaultId: "vlt_01",
      keyEpoch: 1,
      tokenHash: "a".repeat(43),
      namespaces: ["workspace:ws_01"],
      actions: ["read"],
      expiresAt: Date.now() + 60_000,
      keyEnvelope: "opaque",
    };
    expect((await fixture().app.request("/v1/tokens", { method: "POST", body: JSON.stringify({ ...valid, namespaces: ["secrets"] }) })).status).toBe(400);
    expect((await fixture().app.request("/v1/tokens", { method: "POST", body: JSON.stringify({ ...valid, namespaces: ["workspace:ws_01", "workspace:ws_01"] }) })).status).toBe(400);
    expect((await fixture().app.request("/v1/tokens", { method: "POST", body: JSON.stringify({ ...valid, actions: ["read", "read"] }) })).status).toBe(400);
    expect((await fixture().app.request("/v1/tokens", { method: "POST", body: JSON.stringify({ ...valid, actions: ["append"] }) })).status).toBe(400);
    expect((await fixture().app.request("/v1/tokens", { method: "POST", body: JSON.stringify({ ...valid, expiresAt: Date.now() + 25 * 60 * 60 * 1000 }) })).status).toBe(400);
    expect((await fixture({ adminAuthorized: false }).app.request("/v1/tokens", { method: "POST", body: JSON.stringify(valid) })).status).toBe(404);
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

  it("stores and commits scoped namespace objects without exposing another namespace (AU-005, PR-003)", async () => {
    const { app } = fixture({ namespace: "workspace:ws_01" });
    const allowedBase = "/v1/vaults/vlt_01/namespaces/workspace%3Aws_01/objects";
    const forbiddenBase = "/v1/vaults/vlt_01/namespaces/drop%3Aprivate/objects";
    expect((await app.request(`${allowedBase}/obj_manifest`, { method: "PUT", body: Uint8Array.of(1) })).status).toBe(201);
    expect((await app.request(`${allowedBase}/obj_chunk`, { method: "PUT", body: Uint8Array.of(2) })).status).toBe(201);
    expect((await app.request(`${forbiddenBase}/obj_hidden`, { method: "PUT", body: Uint8Array.of(3) })).status).toBe(404);
    expect((await app.request(`${forbiddenBase}/obj_manifest`)).status).toBe(404);

    const committed = await app.request("/v1/vaults/vlt_01/namespace-commits", {
      method: "POST",
      body: JSON.stringify(scopedCommit("op_scoped", "rev_scoped", "workspace:ws_01", null, "nrev_01", "append", "pth_01")),
    });
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ outcome: "committed", revisionId: "rev_scoped" });
    expect(await (await app.request("/v1/vaults/vlt_01/namespaces")).json()).toEqual({
      revisionId: "rev_scoped",
      namespaces: [{ namespace: "workspace:ws_01", revisionId: "nrev_01", manifestObjectId: "obj_manifest", commitMode: "append" }],
      commitProvenance: 1,
    });
    expect(await (await app.request("/v1/vaults/vlt_01/namespaces/workspace%3Aws_01/revisions/nrev_01")).json()).toEqual({
      namespace: "workspace:ws_01",
      revisionId: "nrev_01",
      manifestObjectId: "obj_manifest",
      previousRevisionId: null,
      commitMode: "append",
    });
    expect(await (await app.request("/v1/vaults/vlt_01/scoped-revisions/rev_scoped")).json()).toMatchObject({
      revisionId: "rev_scoped",
      previousRevisionId: null,
      namespaces: [{ namespace: "workspace:ws_01", revisionId: "nrev_01" }],
    });
    expect(await (await app.request("/v1/vaults/vlt_01/snapshots", {
      method: "POST",
      body: JSON.stringify({ id: "snp_scoped", name: "Scoped checkpoint" }),
    })).json()).toMatchObject({ revisionId: "rev_scoped", protocolVersion: "1.1", protected: true });
    expect((await app.request("/v1/vaults/vlt_01/scoped-revisions/rev_missing")).status).toBe(404);
    expect((await app.request("/v1/vaults/vlt_01/namespaces/drop%3Aprivate/revisions/nrev_01")).status).toBe(404);
    expect(new Uint8Array(await (await app.request(`${allowedBase}/obj_chunk`)).arrayBuffer())).toEqual(Uint8Array.of(2));
  });

  it("checks scoped object availability, namespace freshness, and append identity reuse", async () => {
    const { app } = fixture();
    const base = "/v1/vaults/vlt_01/namespaces/harness%3Acodex%3Asandbox/objects";
    const missing = await app.request("/v1/vaults/vlt_01/namespace-commits", {
      method: "POST",
      body: JSON.stringify(scopedCommit("op_missing", "rev_missing", "harness:codex:sandbox", null, "nrev_missing", "append", "pth_01")),
    });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: { code: "OBJECT_MISSING" } });
    await app.request(`${base}/obj_manifest`, { method: "PUT", body: Uint8Array.of(1) });
    await app.request(`${base}/obj_chunk`, { method: "PUT", body: Uint8Array.of(2) });
    expect((await app.request("/v1/vaults/vlt_01/namespace-commits", {
      method: "POST",
      body: JSON.stringify(scopedCommit("op_first", "rev_first", "harness:codex:sandbox", null, "nrev_01", "append", "pth_01")),
    })).status).toBe(200);
    const stale = await app.request("/v1/vaults/vlt_01/namespace-commits", {
      method: "POST",
      body: JSON.stringify(scopedCommit("op_stale", "rev_stale", "harness:codex:sandbox", null, "nrev_02", "append", "pth_02")),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "STALE_BASE" } });
    const duplicate = await app.request("/v1/vaults/vlt_01/namespace-commits", {
      method: "POST",
      body: JSON.stringify(scopedCommit("op_duplicate", "rev_duplicate", "harness:codex:sandbox", "nrev_01", "nrev_02", "append", "pth_01")),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: "APPEND_VIOLATION" } });
  });

  it("previews and executes owner-only reachability GC after the 30-day grace period (BK-003..BK-005)", async () => {
    vi.useFakeTimers();
    try {
      const firstUpload = Date.parse("2026-06-01T00:00:00.000Z");
      vi.setSystemTime(firstUpload);
      const { app } = fixture();
      const base = "/v1/vaults/vlt_01/namespaces/drop%3Adocs/objects";
      await app.request(`${base}/obj_manifest`, { method: "PUT", body: Uint8Array.of(1) });
      await app.request(`${base}/obj_chunk`, { method: "PUT", body: Uint8Array.of(2) });
      expect((await app.request("/v1/vaults/vlt_01/namespace-commits", {
        method: "POST",
        body: JSON.stringify(scopedCommit("op_gc", "srev_gc", "drop:docs", null, "nrev_gc", "replace", "pth_gc")),
      })).status).toBe(200);
      vi.setSystemTime(firstUpload + 1);
      await app.request(`${base}/obj_orphan`, { method: "PUT", body: Uint8Array.of(3, 4, 5) });
      vi.setSystemTime(firstUpload + 31 * 24 * 60 * 60 * 1000);

      const preview = await app.request("/v1/vaults/vlt_01/garbage-collection", {
        method: "POST",
        body: JSON.stringify({ dryRun: true }),
      });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({
        outcome: "completed",
        dryRun: true,
        candidateObjects: 1,
        deletedObjects: 0,
        deleteBytes: 3,
        conservativeScopes: ["legacy"],
      });
      expect((await app.request(`${base}/obj_orphan`)).status).toBe(200);

      const collected = await app.request("/v1/vaults/vlt_01/garbage-collection", {
        method: "POST",
        body: JSON.stringify({ dryRun: false }),
      });
      expect(collected.status).toBe(200);
      expect(await collected.json()).toMatchObject({ outcome: "completed", deletedObjects: 1, deleteBytes: 3 });
      expect((await app.request(`${base}/obj_orphan`)).status).toBe(404);
      expect((await app.request(`${base}/obj_manifest`)).status).toBe(200);
      expect((await app.request(`${base}/obj_chunk`)).status).toBe(200);

      expect((await fixture({ adminAuthorized: false }).app.request("/v1/vaults/vlt_01/garbage-collection", {
        method: "POST",
        body: JSON.stringify({ dryRun: true }),
      })).status).toBe(404);
      expect((await app.request("/v1/vaults/vlt_01/garbage-collection", { method: "POST", body: "{}" })).status).toBe(200);
      expect((await app.request("/v1/vaults/vlt_01/garbage-collection", { method: "POST", body: JSON.stringify({ dryRun: "yes" }) })).status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the GC lease as retryable and runs scheduled retention across active vaults", async () => {
    const { app, services } = fixture();
    for (const objectId of ["obj_manifest", "obj_chunk", "obj_manifest_next", "obj_chunk_next"]) {
      await app.request(`/v1/vaults/vlt_01/namespaces/drop%3Adocs/objects/${objectId}`, { method: "PUT", body: Uint8Array.of(1) });
    }
    await app.request("/v1/vaults/vlt_01/namespace-commits", {
      method: "POST",
      body: JSON.stringify(scopedCommit("op_initial_gc_lock", "srev_initial_gc_lock", "drop:docs", null, "nrev_initial_gc_lock", "replace", "pth_initial")),
    });
    const now = Date.now();
    const lock = await services.coordinator("vlt_01").planGarbageCollection({
      id: "gc_locked",
      now,
      gracePeriodMs: 0,
      leaseMs: 60_000,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: [],
      dryRun: false,
    });
    expect(lock.outcome).toBe("planned");
    const blockedCommit = await app.request("/v1/vaults/vlt_01/namespace-commits", {
      method: "POST",
      body: JSON.stringify({
        ...scopedCommit("op_blocked_gc_lock", "srev_blocked_gc_lock", "drop:docs", "nrev_initial_gc_lock", "nrev_blocked_gc_lock", "replace", "pth_next"),
        updates: [{
          ...scopedCommit("op_blocked_gc_lock", "srev_blocked_gc_lock", "drop:docs", "nrev_initial_gc_lock", "nrev_blocked_gc_lock", "replace", "pth_next").updates[0],
          manifestObjectId: "obj_manifest_next",
          requiredObjectIds: ["obj_chunk_next"],
        }],
      }),
    });
    expect(blockedCommit.status).toBe(409);
    expect(await blockedCommit.json()).toMatchObject({ error: { code: "GC_BUSY", retryAfterMs: expect.any(Number) } });
    const blockedGc = await app.request("/v1/vaults/vlt_01/garbage-collection", {
      method: "POST",
      body: JSON.stringify({ dryRun: false }),
    });
    expect(blockedGc.status).toBe(409);
    expect(await blockedGc.json()).toMatchObject({ error: { code: "GC_BUSY" } });
    await services.coordinator("vlt_01").finalizeGarbageCollection("gc_locked");

    await app.request("/v1/devices/current", { method: "POST", body: JSON.stringify({ id: "dev_01", name: "Scheduled owner" }) });
    await app.request("/v1/vaults", { method: "POST", body: JSON.stringify({ name: "Scheduled vault" }) });
    expect(await runScheduledGarbageCollection(services, Date.now())).toEqual({ vaults: 1, completed: 1, busy: 0, failed: 0 });
  });
});

function commit(operationId: string, baseRevisionId: string | null, revisionId: string, manifestObjectId: string, requiredObjectIds: string[]) {
  return { protocolVersion: "1.0", operationId, baseRevisionId, revisionId, manifestObjectId, requiredObjectIds };
}

function scopedCommit(
  operationId: string,
  vaultRevisionId: string,
  namespace: string,
  baseNamespaceRevisionId: string | null,
  namespaceRevisionId: string,
  mode: "replace" | "append",
  pathId: string,
) {
  return {
    protocolVersion: "1.1",
    operationId,
    vaultRevisionId,
    updates: [{
      namespace,
      baseNamespaceRevisionId,
      namespaceRevisionId,
      manifestObjectId: "obj_manifest",
      requiredObjectIds: ["obj_chunk"],
      mode,
      pathClaims: [{ pathId, mutation: "add" }],
    }],
  };
}

class MemoryObjects implements ObjectStore {
  readonly #values = new Map<string, { bytes: Uint8Array; uploadedAt: number }>();

  async putIfAbsent(vaultId: string, objectId: string, body: ReadableStream<Uint8Array> | Uint8Array, namespace?: string): Promise<{ created: boolean; size: number }> {
    const key = `${vaultId}/${namespace ?? "$legacy"}/${objectId}`;
    const existing = this.#values.get(key);
    if (existing) return { created: false, size: existing.bytes.byteLength };
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    this.#values.set(key, { bytes, uploadedAt: Date.now() });
    return { created: true, size: bytes.byteLength };
  }

  async get(vaultId: string, objectId: string, namespace?: string): Promise<Uint8Array | null> {
    return this.#values.get(`${vaultId}/${namespace ?? "$legacy"}/${objectId}`)?.bytes ?? null;
  }

  async exists(vaultId: string, objectId: string, namespace?: string): Promise<boolean> {
    return this.#values.has(`${vaultId}/${namespace ?? "$legacy"}/${objectId}`);
  }

  async list(vaultId: string): Promise<Array<{ namespace: string | null; objectId: string; uploadedAt: number; size: number }>> {
    const output: Array<{ namespace: string | null; objectId: string; uploadedAt: number; size: number }> = [];
    for (const [key, value] of this.#values) {
      const [candidateVault, scope, objectId] = key.split("/");
      if (candidateVault !== vaultId || !scope || !objectId) continue;
      output.push({ namespace: scope === "$legacy" ? null : scope, objectId, uploadedAt: value.uploadedAt, size: value.bytes.byteLength });
    }
    return output;
  }

  async delete(vaultId: string, objects: ReadonlyArray<{ namespace: string | null; objectId: string }>): Promise<void> {
    for (const object of objects) this.#values.delete(`${vaultId}/${object.namespace ?? "$legacy"}/${object.objectId}`);
  }

  bytes(vaultId: string, objectId: string): Uint8Array | undefined {
    return this.#values.get(`${vaultId}/$legacy/${objectId}`)?.bytes;
  }
}

class MemoryControl implements ControlPlane {
  readonly #vaults: Array<{ id: string; name: string; role: "owner" }> = [];
  readonly #devices = new Map<string, { id: string; name: string; status: "active" | "revoked"; publicExchangeKey?: string }>([
    ["dev_old", { id: "dev_old", name: "Old laptop", status: "active" }],
  ]);
  readonly #vaultDevices = new Map<string, Set<string>>();
  readonly #keyEpochs = new Map<string, number>();
  readonly #keyEnvelopes = new Map<string, string>();

  addVaultDevice(vaultId: string, device: { id: string; publicExchangeKey: string }): void {
    const existing = this.#devices.get(device.id);
    this.#devices.set(device.id, {
      id: device.id,
      name: existing?.name ?? device.id,
      status: "active",
      publicExchangeKey: device.publicExchangeKey,
    });
    this.#vaultDevices.get(vaultId)?.add(device.id);
  }

  async registerDevice(principalValue: Principal, input: { id: string; name: string; publicExchangeKey?: string }): Promise<{ accountId: string; deviceId: string; name: string }> {
    this.#devices.set(input.id, { id: input.id, name: input.name, status: "active", publicExchangeKey: input.publicExchangeKey });
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
    this.#vaultDevices.set(vault.id, new Set([principal.deviceId]));
    this.#keyEpochs.set(vault.id, 1);
    return vault;
  }

  async listVaults(): Promise<Array<{ id: string; name: string; role: "owner" }>> {
    return this.#vaults;
  }

  async joinVault(_principalValue: Principal, vaultId: string): Promise<{ id: string; role: "owner" }> {
    this.#vaultDevices.get(vaultId)?.add(principal.deviceId);
    return { id: vaultId, role: "owner" };
  }

  async listVaultKeyRecipients(_principalValue: Principal, vaultId: string): Promise<{ keyEpoch: number; devices: Array<{ id: string; publicExchangeKey: string }> }> {
    const devices = [...(this.#vaultDevices.get(vaultId) ?? [])]
      .map((id) => this.#devices.get(id))
      .filter((device): device is NonNullable<typeof device> & { publicExchangeKey: string } =>
        device?.status === "active" && typeof device.publicExchangeKey === "string")
      .map((device) => ({ id: device.id, publicExchangeKey: device.publicExchangeKey }))
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    return { keyEpoch: this.#keyEpochs.get(vaultId) ?? 1, devices };
  }

  async vaultKeyEnvelope(principalValue: Principal, vaultId: string): Promise<{ keyEpoch: number; envelope: string } | null> {
    const keyEpoch = this.#keyEpochs.get(vaultId) ?? 1;
    const envelope = this.#keyEnvelopes.get(`${vaultId}:${keyEpoch}:${principalValue.deviceId}`);
    return envelope ? { keyEpoch, envelope } : null;
  }

  async vaultKeyEnvelopes(principalValue: Principal, vaultId: string, afterEpoch: number): Promise<{
    keyEpoch: number;
    envelopes: Array<{ keyEpoch: number; envelope: string }>;
  }> {
    const keyEpoch = this.#keyEpochs.get(vaultId) ?? 1;
    const current = await this.vaultKeyEnvelope(principalValue, vaultId);
    return { keyEpoch, envelopes: current && current.keyEpoch > afterEpoch ? [current] : [] };
  }

  async vaultKeyEpoch(_principalValue: Principal, vaultId: string): Promise<number | null> {
    return this.#keyEpochs.get(vaultId) ?? 1;
  }

  async rotateVaultKey(_principalValue: Principal, vaultId: string, input: {
    expectedEpoch: number;
    newEpoch: number;
    envelopes: Array<{ deviceId: string; envelope: string }>;
  }): Promise<{ outcome: "rotated"; keyEpoch: number } | { outcome: "stale-epoch" } | { outcome: "recipient-mismatch" }> {
    const currentEpoch = this.#keyEpochs.get(vaultId) ?? 1;
    if (input.expectedEpoch !== currentEpoch || input.newEpoch !== currentEpoch + 1) return { outcome: "stale-epoch" };
    const active = [...(this.#vaultDevices.get(vaultId) ?? [])]
      .filter((id) => this.#devices.get(id)?.status === "active")
      .sort((left, right) => left.localeCompare(right, "en"));
    const recipients = input.envelopes.map((item) => item.deviceId).sort((left, right) => left.localeCompare(right, "en"));
    if (active.join("\0") !== recipients.join("\0") || active.some((id) => !this.#devices.get(id)?.publicExchangeKey)) {
      return { outcome: "recipient-mismatch" };
    }
    for (const item of input.envelopes) this.#keyEnvelopes.set(`${vaultId}:${input.newEpoch}:${item.deviceId}`, item.envelope);
    this.#keyEpochs.set(vaultId, input.newEpoch);
    return { outcome: "rotated", keyEpoch: input.newEpoch };
  }

  async listActiveVaultIds(): Promise<string[]> {
    return this.#vaults.map((vault) => vault.id).sort((left, right) => left.localeCompare(right, "en"));
  }
}

class MemoryCapabilities implements CapabilityService {
  readonly #records = new Map<string, {
    summary: Awaited<ReturnType<CapabilityService["create"]>>;
    tokenHash: string;
    keyEnvelope: string;
  }>();

  async create(_principalValue: Principal, input: Parameters<CapabilityService["create"]>[1]): Promise<Awaited<ReturnType<CapabilityService["create"]>>> {
    const summary = { id: input.id, vaultId: input.vaultId, namespaces: input.namespaces, actions: input.actions, expiresAt: input.expiresAt, createdAt: Date.now() };
    this.#records.set(input.id, { summary, tokenHash: input.tokenHash, keyEnvelope: input.keyEnvelope });
    return summary;
  }

  async list(): Promise<Awaited<ReturnType<CapabilityService["list"]>>> {
    return [...this.#records.values()].map((record) => record.summary);
  }

  async revoke(_principalValue: Principal, capabilityId: string): Promise<void> {
    const record = this.#records.get(capabilityId);
    if (!record) throw new ControlPlaneError("not-found");
    record.summary.revokedAt = Date.now();
  }

  async redeem(token: string): Promise<Awaited<ReturnType<CapabilityService["redeem"]>>> {
    const hash = await sha256(token);
    const record = [...this.#records.values()].find((candidate) => candidate.tokenHash === hash);
    if (!record || record.summary.redeemedAt || record.summary.revokedAt || record.summary.expiresAt <= Date.now()) return null;
    record.summary.redeemedAt = Date.now();
    return {
      accessToken: `stc_access_${"b".repeat(43)}`,
      expiresAt: record.summary.expiresAt,
      vaultId: record.summary.vaultId,
      namespaces: record.summary.namespaces,
      actions: record.summary.actions,
      keyEnvelope: record.keyEnvelope,
    };
  }
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Buffer.from(digest).toString("base64url");
}
