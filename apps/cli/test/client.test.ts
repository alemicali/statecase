import { describe, expect, it } from "vitest";

import { RemoteError, StatecaseClient } from "../src/client.js";
import { CLIENT_HEADERS, SERVICE_HEALTH } from "@statecase/protocol";

const compatible = (fetcher: typeof fetch): typeof fetch => async (input, init) =>
  new URL(String(input)).pathname === "/health" ? Response.json(SERVICE_HEALTH) : fetcher(input, init);

describe("HTTP client contract (PR-001, AU-011)", () => {
  it("retries a disconnected health stream as a network failure, without exposing transport diagnostics (PR-014)", async () => {
    let disconnected = true, protectedCalls = 0, healthCalls = 0;
    const client = new StatecaseClient("https://statecase.test", "token", async (input) => {
      if (new URL(String(input)).pathname !== "/health") { protectedCalls++; return Response.json({ vaults: [] }); }
      healthCalls++;
      return disconnected ? new Response(new ReadableStream({ start(controller) { controller.error(new Error("private-network-canary")); } })) : Response.json(SERVICE_HEALTH);
    });
    await expect(client.listVaults()).rejects.toEqual(new RemoteError(0, "NETWORK_ERROR", "Statecase service is unavailable"));
    expect(protectedCalls).toBe(0); disconnected = false;
    await client.listVaults(); expect(healthCalls).toBe(2); expect(protectedCalls).toBe(1);
  });
  it.each([0, 1])("enforces the exact 16 KiB health response boundary (+%i byte)", async (extra) => {
    let calls = 0;
    const health = JSON.stringify(SERVICE_HEALTH).padEnd(16 * 1024 + extra, " ");
    const client = new StatecaseClient("https://statecase.test", "token", async () => ++calls === 1 ? new Response(health) : Response.json({ vaults: [] }));
    if (extra) { await expect(client.listVaults()).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" }); expect(calls).toBe(1); }
    else { await expect(client.listVaults()).resolves.toEqual([]); expect(calls).toBe(2); }
  });
  it("shares one bounded public handshake across concurrent operations and declares capabilities on every request (PR-014)", async () => {
    const calls: string[] = [];
    const client = new StatecaseClient("https://statecase.test/", "private-token", async (input, init) => {
      const path = new URL(String(input)).pathname; calls.push(path);
      const headers = new Headers(init?.headers);
      if (path === "/health") {
        expect(headers.has("authorization")).toBe(false); expect(init?.redirect).toBe("error"); expect(init?.signal).toBeDefined();
        const bytes = new TextEncoder().encode(JSON.stringify(SERVICE_HEALTH));
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 20)); controller.enqueue(bytes.slice(20)); controller.close(); } }));
      }
      for (const [name, value] of Object.entries(CLIENT_HEADERS)) expect(headers.get(name)).toBe(value);
      expect(headers.get("authorization")).toBe("Bearer private-token");
      return Response.json({ vaults: [], devices: [] });
    });
    await Promise.all([client.listVaults(), client.listDevices()]); await client.listVaults();
    expect(calls.filter((path) => path === "/health")).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });
  it("rechecks after handshake failure and after a server-required upgrade (PR-014)", async () => {
    let healthy = false, upgrades = false, healthReads = 0, protectedCalls = 0;
    const client = new StatecaseClient("https://statecase.test", "token", async (input) => {
      if (new URL(String(input)).pathname === "/health") {
        healthReads++;
        return Response.json(!healthy ? {} : upgrades ? { ...SERVICE_HEALTH, compatibility: { ...SERVICE_HEALTH.compatibility, requiredCapabilities: ["unknown-required-v2"] } } : SERVICE_HEALTH);
      }
      protectedCalls++;
      if (upgrades) return Response.json({ error: { code: "CLIENT_UPGRADE_REQUIRED", message: "upgrade required" } }, { status: 426 });
      return Response.json({ vaults: [] });
    });
    await expect(client.listVaults()).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
    healthy = true; await client.listVaults(); upgrades = true;
    await expect(client.listVaults()).rejects.toMatchObject({ code: "CLIENT_UPGRADE_REQUIRED" });
    await expect(client.listVaults()).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
    expect(healthReads).toBe(3); expect(protectedCalls).toBe(2);
  });
  it("cancels oversized health bodies without exposing their content or making protected requests (PR-014)", async () => {
    let cancelled = false, calls = 0;
    const client = new StatecaseClient("https://statecase.test", "token", async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("private-canary".repeat(2000))); }, cancel() { cancelled = true; } }));
    });
    await expect(client.listVaults()).rejects.toMatchObject({ status: 426, code: "UNSUPPORTED_PROTOCOL" });
    expect(cancelled).toBe(true); expect(calls).toBe(1);
  });
  it.each(["network", "malformed", "utf8", "empty", "not-found", "unavailable", "limited"])("redacts failed public negotiation: %s", async (kind) => {
    const client = new StatecaseClient("https://statecase.test", "token", async () => {
      if (kind === "network") throw new Error("private-canary");
      if (kind === "empty") return new Response(null, { status: 204 });
      if (kind === "utf8") return new Response(Uint8Array.of(255));
      return new Response("private-canary", { status: kind === "not-found" ? 404 : kind === "unavailable" ? 503 : kind === "limited" ? 429 : 200 });
    });
    try { await client.listVaults(); throw new Error("expected refusal"); }
    catch (error) { expect(error).toBeInstanceOf(RemoteError); expect(String(error)).not.toContain("private-canary"); }
  });
  it("refuses a legacy service before transmitting credentials, objects or bootstrap tokens (PR-014)", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const client = new StatecaseClient("https://statecase.test", "private-token", async (input, init) => {
      calls.push({ path: new URL(String(input)).pathname, init });
      return Response.json({ protocolVersion: "1.1", service: "statecase", status: "ok" });
    });
    await expect(client.putNamespaceObject("vlt_test", "drop:docs", "obj_one", Uint8Array.of(1))).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
    await expect(client.redeemBootstrap("private-bootstrap-token")).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
    expect(calls.map((call) => call.path)).toEqual(["/health", "/health"]);
    for (const call of calls) { expect(new Headers(call.init?.headers).has("authorization")).toBe(false); expect(call.init?.body).toBeUndefined(); }
  });
  it("binds enrollment to the recovery epoch while retaining epoch-one compatibility (CR-010)", async () => {
    const bodies: unknown[] = [];
    const client = new StatecaseClient("https://statecase.test", "token", compatible(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "vlt_test", role: "writer" });
    }));
    await client.joinVault("vlt_test");
    await client.joinVault("vlt_test", 2);
    expect(bodies).toEqual([{ keyEpoch: 1 }, { keyEpoch: 2 }]);
  });
  it("sends bearer identity without exposing it in errors", async () => {
    let authorization: string | null = null;
    const client = new StatecaseClient("https://statecase.test/", "top-secret-token", compatible(async (_input, init) => {
      const headers = new Headers(init?.headers);
      authorization = headers.get("authorization");
      return Response.json({ error: { code: "NOPE", message: "safe failure" } }, { status: 409 });
    }));
    await expect(client.listVaults()).rejects.toEqual(new RemoteError(409, "NOPE", "safe failure"));
    expect(authorization).toBe("Bearer top-secret-token");
    await client.listVaults().catch((error: Error) => expect(`${error.name}: ${error.message}`).not.toContain("top-secret-token"));
  });

  it("maps transport and malformed JSON failures to stable redacted errors", async () => {
    const offline = new StatecaseClient("https://statecase.test", undefined, async () => { throw new Error("contains a secret"); });
    await expect(offline.startDeviceCode()).rejects.toEqual(new RemoteError(0, "NETWORK_ERROR", "Statecase service is unavailable"));
    const malformed = new StatecaseClient("https://statecase.test", undefined, async () => new Response("bad", { status: 200 }));
    await expect(malformed.startDeviceCode()).rejects.toEqual(new RemoteError(200, "INVALID_RESPONSE", "service returned an invalid response"));
    const oauth = new StatecaseClient("https://statecase.test", undefined, async () => Response.json({ error: "authorization_pending", error_description: "pending" }, { status: 400 }));
    await expect(oauth.startDeviceCode()).rejects.toEqual(new RemoteError(400, "authorization_pending", "pending"));
    const empty = new StatecaseClient("https://statecase.test", undefined, async () => Response.json({}, { status: 418 }));
    await expect(empty.startDeviceCode()).rejects.toEqual(new RemoteError(418, "REMOTE_ERROR", "Statecase request failed"));
  });

  it("covers the complete typed service surface", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const client = new StatecaseClient("https://statecase.test", "token", compatible(async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method ?? "GET" });
      if (path.endsWith("/code")) return Response.json({ device_code: "device", user_code: "USER", verification_uri: "https://verify", expires_in: 600, interval: 5 });
      if (path.endsWith("/token")) return Response.json({ access_token: "issued" });
      if (path.endsWith("/devices/current")) return Response.json({ accountId: "a", deviceId: "d", name: "device" });
      if (path === "/v1/devices") return Response.json({ devices: [] });
      if (path.startsWith("/v1/devices/") && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (path === "/v1/vaults" && init?.method === "POST") return Response.json({ id: "vlt_one", role: "owner" });
      if (path === "/v1/vaults") return Response.json({ vaults: [] });
      if (path.endsWith("/join")) return Response.json({ id: "vlt_one", role: "writer" });
      if (path.endsWith("/key-recipients")) return Response.json({ keyEpoch: 1, devices: [] });
      if (path.endsWith("/key-envelope")) return Response.json({ keyEpoch: 2, envelope: "sealed" });
      if (path.endsWith("/key-envelopes")) return Response.json({ keyEpoch: 2, envelopes: [{ keyEpoch: 2, envelope: "sealed" }] });
      if (path.endsWith("/key-rotations")) return Response.json({ keyEpoch: 2, rotated: true });
      if (path.endsWith("/head")) return Response.json({ revisionId: null, manifestObjectId: null });
      if (path.endsWith("/namespaces")) return Response.json({ revisionId: "rev_scoped", namespaces: [{ namespace: "workspace:ws_01", revisionId: "nrev_01", manifestObjectId: "obj_manifest" }] });
      if (path.includes("/namespaces/") && path.includes("/revisions/")) return Response.json({ namespace: "workspace:ws_01", revisionId: "nrev_01", manifestObjectId: "obj_manifest", previousRevisionId: null });
      if (path.includes("/scoped-revisions/")) return Response.json({ revisionId: "rev_scoped", previousRevisionId: null, namespaces: [{ namespace: "workspace:ws_01", revisionId: "nrev_01", manifestObjectId: "obj_manifest" }] });
      if (path === "/v1/tokens" && init?.method === "POST") return Response.json({ id: "cap_one", vaultId: "vlt_one", namespaces: ["workspace:ws_01"], actions: ["read"], expiresAt: 2, createdAt: 1 });
      if (path === "/v1/tokens") return Response.json({ tokens: [] });
      if (path.startsWith("/v1/tokens/") && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (path === "/api/bootstrap/redeem") return Response.json({ accessToken: "scoped", expiresAt: 2, vaultId: "vlt_one", namespaces: ["workspace:ws_01"], actions: ["read"], keyEnvelope: "opaque" });
      if (path.endsWith("/snapshots") && init?.method === "POST") return Response.json({ id: "snp_one", name: "snapshot", revisionId: "rev_one", manifestObjectId: "obj_one", protected: true, createdAt: 1 });
      if (path.endsWith("/snapshots")) return Response.json({ snapshots: [] });
      if (path.includes("/snapshots/") && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (path.includes("/revisions/")) return Response.json({ revisionId: "rev_one", manifestObjectId: "obj_one", previousRevisionId: null });
      return Response.json({ outcome: "committed", revisionId: "rev_one" });
    }));
    await client.startDeviceCode();
    await client.pollDeviceCode("device");
    await client.registerDevice({ id: "dev_stable", name: "device", publicExchangeKey: `stc_x25519_public_v1.${"a".repeat(43)}` });
    await client.listDevices();
    await client.revokeDevice("dev_old");
    await client.createVault("vault");
    await client.listVaults();
    await client.joinVault("vlt_one");
    await client.vaultKeyRecipients("vlt_one");
    await client.vaultKeyEnvelope("vlt_one");
    await client.vaultKeyEnvelopes("vlt_one", 1);
    await client.rotateVaultKey("vlt_one", { expectedEpoch: 1, newEpoch: 2, envelopes: [{ deviceId: "dev_stable", envelope: "sealed" }] });
    await client.head("vlt_one");
    await client.namespaceHeads("vlt_one");
    await client.namespaceRevision("vlt_one", "workspace:ws_01", "nrev_01");
    await client.scopedRevision("vlt_one", "rev_scoped");
    await client.revision("vlt_one", "rev_one");
    await client.createSnapshot("vlt_one", "snapshot");
    await client.listSnapshots("vlt_one");
    await client.deleteSnapshot("vlt_one", "snp_one");
    await client.createCapability({ id: "cap_one", vaultId: "vlt_one", keyEpoch: 1, tokenHash: "a".repeat(43), namespaces: ["workspace:ws_01"], actions: ["read"], expiresAt: 2, keyEnvelope: "opaque" });
    await client.listCapabilities();
    await client.revokeCapability("cap_one");
    await client.redeemBootstrap("stc_boot_" + "a".repeat(43));
    await client.putNamespaceObject("vlt_one", "workspace:ws_01", "obj_one", new Uint8Array([1]));
    await client.getNamespaceObject("vlt_one", "workspace:ws_01", "obj_one");
    await client.commitNamespaces("vlt_one", {
      protocolVersion: "1.1", operationId: "op_scoped", vaultRevisionId: "rev_scoped", updates: [{ namespace: "workspace:ws_01", baseNamespaceRevisionId: null, namespaceRevisionId: "nrev_01", manifestObjectId: "obj_manifest", requiredObjectIds: [], mode: "replace", pathClaims: [] }],
    });
    await client.commit("vlt_one", {
      protocolVersion: "1.0", operationId: "op_one", baseRevisionId: null, revisionId: "rev_one", manifestObjectId: "obj_one", requiredObjectIds: [],
    });
    expect(calls).toHaveLength(28);
  });
});
