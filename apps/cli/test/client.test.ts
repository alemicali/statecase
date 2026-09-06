import { describe, expect, it } from "vitest";

import { RemoteError, StatecaseClient } from "../src/client.js";

describe("HTTP client contract (PR-001, AU-011)", () => {
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
      if (path.endsWith("/head")) return Response.json({ revisionId: null, manifestObjectId: null });
      return Response.json({ outcome: "committed", revisionId: "rev_one" });
    });
    await client.startDeviceCode();
    await client.pollDeviceCode("device");
    await client.registerDevice({ id: "dev_stable", name: "device" });
    await client.listDevices();
    await client.revokeDevice("dev_old");
    await client.createVault("vault");
    await client.listVaults();
    await client.joinVault("vlt_one");
    await client.head("vlt_one");
    await client.commit("vlt_one", {
      protocolVersion: "1.0", operationId: "op_one", baseRevisionId: null, revisionId: "rev_one", manifestObjectId: "obj_one", requiredObjectIds: [],
    });
    expect(calls).toHaveLength(10);
  });
});
