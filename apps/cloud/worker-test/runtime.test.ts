import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { VaultCoordinator } from "../src/bindings.js";

describe("Statecase in workerd (PR-001, PR-005, PR-010, PR-011, AU-001)", () => {
  it("runs the real Worker entrypoint", async () => {
    const response = await exports.default.fetch("http://statecase.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ protocolVersion: "1.0", service: "statecase", status: "ok" });
  });

  it("applies the complete D1 control and auth schema", async () => {
    const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
    const names = rows.results.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["vaults", "devices", "bootstrap_tokens", "user", "session", "deviceCode"]));
  });

  it("issues a real RFC 8628 device code for the registered CLI", async () => {
    const response = await exports.default.fetch("http://statecase.test/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "statecase-cli", scope: "sync" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      expires_in: 600,
      interval: 5,
      verification_uri: "http://localhost:8787/device",
    });
  });

  it("rejects unregistered device clients", async () => {
    const response = await exports.default.fetch("http://statecase.test/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "attacker" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });

  it("rejects account creation outside the private MVP allowlist", async () => {
    const response = await exports.default.fetch("http://statecase.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "attacker@example.test", name: "Attacker", password: "a-strong-attacker-password" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "SIGNUP_DISABLED" });
  });

  it("registers an authenticated installation and persists its first vault in D1", async () => {
    const signup = await exports.default.fetch("http://statecase.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "runtime@statecase.test", name: "Runtime Operator", password: "a-strong-runtime-password" }),
    });
    expect(signup.status).toBe(200);
    const token = signup.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    const authenticated = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const registration = await exports.default.fetch("http://statecase.test/v1/devices/current", {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify({ name: "Isolated workerd" }),
    });
    expect(registration.status).toBe(200);
    expect(await registration.json()).toMatchObject({ name: "Isolated workerd" });

    const created = await exports.default.fetch("http://statecase.test/v1/vaults", {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify({ name: "Runtime vault" }),
    });
    expect(created.status).toBe(201);
    const vault = await created.json() as { id: string; role: string };
    expect(vault).toMatchObject({ role: "owner" });
    expect(vault.id).toMatch(/^vlt_[a-f0-9]{32}$/u);

    const listed = await exports.default.fetch("http://statecase.test/v1/vaults", { headers: authenticated });
    expect(await listed.json()).toMatchObject({ vaults: [{ id: vault.id, role: "owner" }] });
  });

  it("completes the browser approval and one-time CLI token exchange", async () => {
    const issued = await exports.default.fetch("http://statecase.test/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "statecase-cli", scope: "sync" }),
    });
    const code = await issued.json() as { device_code: string; user_code: string };
    const signup = await exports.default.fetch("http://statecase.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "approval@statecase.test", name: "Approval Operator", password: "another-strong-runtime-password" }),
    });
    const cookie = signup.headers.get("set-cookie");
    expect(cookie).toBeTruthy();

    const inspected = await exports.default.fetch(`http://statecase.test/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`, {
      headers: { cookie: cookie! },
    });
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({ client_id: "statecase-cli" });
    const approved = await exports.default.fetch("http://statecase.test/api/auth/device/approve", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie!, origin: "http://localhost:8787" },
      body: JSON.stringify({ userCode: code.user_code }),
    });
    expect(approved.status).toBe(200);

    const exchanged = await exports.default.fetch("http://statecase.test/api/auth/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "statecase-cli",
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    expect(exchanged.status).toBe(200);
    expect(await exchanged.json()).toMatchObject({ access_token: expect.any(String), token_type: "Bearer" });
    const replay = await exports.default.fetch("http://statecase.test/api/auth/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "statecase-cli",
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    expect(replay.status).toBe(400);
  });

  it("persists Durable Object commits across stubs", async () => {
    const vaults = env.VAULTS as DurableObjectNamespace<VaultCoordinator>;
    const firstStub = vaults.getByName("vlt_runtime");
    const request = {
      protocolVersion: "1.0" as const,
      operationId: "op_runtime",
      baseRevisionId: null,
      revisionId: "rev_runtime",
      manifestObjectId: "obj_manifest",
      requiredObjectIds: [],
    };
    expect(await firstStub.commit(request)).toMatchObject({ outcome: "committed", revisionId: "rev_runtime" });
    expect(await vaults.getByName("vlt_runtime").head()).toEqual({
      revisionId: "rev_runtime",
      manifestObjectId: "obj_manifest",
    });
  });

  it("provides an isolated R2 binding for opaque bytes", async () => {
    await env.BLOBS.put("v1/test/object", Uint8Array.of(7, 8, 9));
    const object = await env.BLOBS.get("v1/test/object");
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(Uint8Array.of(7, 8, 9));
  });
});
