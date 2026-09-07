import { describe, expect, it } from "vitest";

import { RemoteError, StatecaseClient } from "../src/client.js";

describe("HTTP client contract (PR-001, AU-011)", () => {
  it("binds enrollment to the recovery epoch while retaining epoch-one compatibility (CR-010)", async () => {
    const bodies: unknown[] = [];
    const client = new StatecaseClient("https://statecase.test", "token", async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "vlt_test", role: "writer" });
    });
    await client.joinVault("vlt_test");
    await client.joinVault("vlt_test", 2);
    expect(bodies).toEqual([{ keyEpoch: 1 }, { keyEpoch: 2 }]);
  });
  it("sends bearer identity without exposing it in errors", async () => {
    let authorization: string | null = null;
    const client = new StatecaseClient("https://statecase.test/", "top-secret-token", async (_input, init) => {
      const headers = new Headers(init?.headers);
      authorization = headers.get("authorization");
      return Response.json({ error: { code: "NOPE", message: "safe failure" } }, { status: 409 });
    });
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
    const client = new StatecaseClient("https://statecase.test", "token", async (input, init) => {
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
    });
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
