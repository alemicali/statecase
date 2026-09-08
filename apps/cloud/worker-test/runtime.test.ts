import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createCloudServices, type StatecaseEnvironment, type VaultCoordinator } from "../src/bindings.js";

describe("Statecase in workerd (PR-001, PR-005, PR-010, PR-011, AU-001)", () => {
  it("runs the real Worker entrypoint", async () => {
    const response = await exports.default.fetch("http://statecase.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ protocolVersion: "1.1", legacyProtocolVersion: "1.0", service: "statecase", status: "ok" });
  });

  it("applies the complete D1 control and auth schema", async () => {
    const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
    const names = rows.results.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining([
      "vaults", "devices", "device_sessions", "vault_key_envelopes", "bootstrap_tokens", "capability_grants", "capability_sessions", "user", "session", "deviceCode",
    ]));
  });

  it("stores a new vault-key epoch atomically for every active member (CR-010, AU-008)", async () => {
    const signup = await exports.default.fetch("http://statecase.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "rotation@statecase.test", name: "Rotation Operator", password: "a-strong-rotation-password" }),
    });
    const token = signup.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const currentPublicKey = `stc_x25519_public_v1.${"a".repeat(43)}`;
    const peerPublicKey = `stc_x25519_public_v1.${"b".repeat(43)}`;
    const registered = await exports.default.fetch("http://statecase.test/v1/devices/current", {
      method: "POST", headers, body: JSON.stringify({ id: "dev_rotation", name: "Rotation device", publicExchangeKey: currentPublicKey }),
    });
    const account = await registered.json() as { accountId: string };
    expect((await exports.default.fetch("http://statecase.test/v1/devices/current", {
      method: "POST", headers, body: JSON.stringify({ id: "dev_rotation", name: "Same installation" }),
    })).status).toBe(200);
    expect(await env.DB.prepare("SELECT public_exchange_key FROM devices WHERE id = 'dev_rotation'").first("public_exchange_key")).toBe(currentPublicKey);
    expect((await exports.default.fetch("http://statecase.test/v1/devices/current", {
      method: "POST", headers, body: JSON.stringify({ id: "dev_rotation", name: "Changed key", publicExchangeKey: peerPublicKey }),
    })).status).toBe(409);
    await expect(env.DB.prepare("UPDATE devices SET public_exchange_key = ? WHERE id = 'dev_rotation'").bind(peerPublicKey).run())
      .rejects.toThrow("device exchange key is immutable");
    const created = await exports.default.fetch("http://statecase.test/v1/vaults", {
      method: "POST", headers, body: JSON.stringify({ name: "Rotation vault" }),
    });
    const vault = await created.json() as { id: string };
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO devices (id, account_id, name, public_exchange_key, status, created_at, last_seen_at) VALUES (?, ?, ?, ?, 'active', ?, ?)")
        .bind("dev_rotation_peer", account.accountId, "Rotation peer", peerPublicKey, now, now),
      env.DB.prepare("INSERT INTO vault_members (vault_id, device_id, role, created_at) VALUES (?, ?, 'writer', ?)")
        .bind(vault.id, "dev_rotation_peer", now),
      env.DB.prepare("INSERT INTO capability_grants (id, account_id, creator_device_id, vault_id, token_hash, namespaces_json, actions_json, key_envelope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind("cap_rotation", account.accountId, "dev_rotation", vault.id, "rotation-token-hash", "[\"drop:rotated\"]", "[\"read\"]", "opaque", now + 60_000, now),
      env.DB.prepare("INSERT INTO capability_sessions (id, grant_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind("caps_rotation", "cap_rotation", "rotation-access-hash", now + 60_000, now),
    ]);

    const recipients = await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/key-recipients`, { headers });
    expect(await recipients.json()).toEqual({ keyEpoch: 1, devices: [
      { id: "dev_rotation", publicExchangeKey: currentPublicKey },
      { id: "dev_rotation_peer", publicExchangeKey: peerPublicKey },
    ] });

    // The mutation boundary must still require an active owner, not merely
    // a recipient who was authorized to write ordinary namespace data.
    await expect(env.DB.prepare(`INSERT INTO vault_key_envelopes
      (vault_id, key_epoch, device_id, envelope, created_by_device_id, created_at)
      VALUES (?, 2, 'dev_rotation', 'unauthorized-wrap', 'dev_rotation_peer', ?)`)
      .bind(vault.id, now).run()).rejects.toThrow("invalid vault key issuer");

    const incomplete = await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/key-rotations`, {
      method: "POST", headers, body: JSON.stringify({ expectedEpoch: 1, newEpoch: 2, envelopes: [
        { deviceId: "dev_rotation", envelope: "sealed-current" },
      ] }),
    });
    expect(incomplete.status).toBe(409);
    expect(await env.DB.prepare("SELECT key_epoch FROM vaults WHERE id = ?").bind(vault.id).first("key_epoch")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM vault_key_envelopes WHERE vault_id = ?").bind(vault.id).first("count")).toBe(0);

    const rotated = await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/key-rotations`, {
      method: "POST", headers, body: JSON.stringify({ expectedEpoch: 1, newEpoch: 2, envelopes: [
        { deviceId: "dev_rotation", envelope: "sealed-current" },
        { deviceId: "dev_rotation_peer", envelope: "sealed-peer" },
      ] }),
    });
    expect(rotated.status).toBe(201);
    expect(await rotated.json()).toEqual({ keyEpoch: 2, rotated: true });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM vault_key_envelopes WHERE vault_id = ? AND key_epoch = 2").bind(vault.id).first("count")).toBe(2);
    expect(await env.DB.prepare("SELECT revoked_at FROM capability_grants WHERE id = 'cap_rotation'").first("revoked_at")).toEqual(expect.any(Number));
    expect(await env.DB.prepare("SELECT revoked_at FROM capability_sessions WHERE id = 'caps_rotation'").first("revoked_at")).toEqual(expect.any(Number));
    const ownEnvelope = await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/key-envelope`, { headers });
    expect(ownEnvelope.headers.get("cache-control")).toBe("no-store");
    expect(await ownEnvelope.json()).toEqual({ keyEpoch: 2, envelope: "sealed-current" });
    const envelopeHistory = await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/key-envelopes?afterEpoch=1`, { headers });
    expect(envelopeHistory.headers.get("cache-control")).toBe("no-store");
    expect(await envelopeHistory.json()).toEqual({ keyEpoch: 2, envelopes: [{ keyEpoch: 2, envelope: "sealed-current" }] });
    const services = createCloudServices(env as StatecaseEnvironment);
    const issuer = { accountId: account.accountId, deviceId: "dev_rotation", sessionId: "rotation-fixture", scopes: ["sync"] };
    const lateCapability = { id: "cap_late_rotation", vaultId: vault.id, keyEpoch: 1, tokenHash: "late-rotation-hash",
      namespaces: ["drop:rotated"], actions: ["read" as const], expiresAt: Date.now() + 60_000, keyEnvelope: "opaque-old-epoch" };
    await expect(services.capabilities.create(issuer, lateCapability)).rejects.toThrow("vault key epoch advanced");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM capability_grants WHERE id = ?").bind(lateCapability.id).first("count")).toBe(0);
    expect(await services.capabilities.create(issuer, { ...lateCapability, keyEpoch: 2 })).toMatchObject({ id: lateCapability.id });

    const namespace = "drop:rotated-runtime";
    const objectUrl = `http://statecase.test/v1/vaults/${vault.id}/namespaces/${encodeURIComponent(namespace)}/objects/obj_rotated_manifest`;
    expect((await exports.default.fetch(objectUrl, { method: "PUT", headers, body: Uint8Array.of(1) })).status).toBe(201);
    const staleCommit = await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/namespace-commits`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        protocolVersion: "1.1",
        operationId: "op_rotated_stale",
        vaultRevisionId: "srev_rotated_stale",
        updates: [{
          namespace,
          keyEpoch: 1,
          baseNamespaceRevisionId: null,
          namespaceRevisionId: "nrev_rotated_stale",
          manifestObjectId: "obj_rotated_manifest",
          requiredObjectIds: [],
          mode: "replace",
          pathClaims: [],
        }],
      }),
    });
    expect(staleCommit.status).toBe(409);
    expect(await staleCommit.json()).toMatchObject({ error: { code: "KEY_EPOCH_CONFLICT" } });
    const legacyCommit = await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/commits`, {
      method: "POST", headers, body: JSON.stringify({}),
    });
    expect(legacyCommit.status).toBe(409);
    expect(await legacyCommit.json()).toMatchObject({ error: { code: "KEY_EPOCH_CONFLICT" } });

    // Models a request that passed the HTTP epoch check before rotation and
    // reached the ordered decision boundary only after rotation committed.
    const coordinator = (env.VAULTS as DurableObjectNamespace<VaultCoordinator>).getByName(vault.id);
    const delayed = {
      protocolVersion: "1.1" as const, operationId: "op_delayed_rotation", vaultRevisionId: "srev_delayed_rotation",
      updates: [{ namespace, keyEpoch: 1, baseNamespaceRevisionId: null,
        namespaceRevisionId: "nrev_delayed_rotation", manifestObjectId: "obj_rotated_manifest",
        requiredObjectIds: [], mode: "replace" as const, pathClaims: [] }],
    };
    expect(await coordinator.commitNamespaces(delayed, vault.id)).toEqual({ outcome: "key-epoch-conflict" });
    expect(await coordinator.commit({ protocolVersion: "1.0", operationId: "op_delayed_legacy", revisionId: "rev_delayed_legacy",
      baseRevisionId: null, manifestObjectId: "obj_rotated_manifest", requiredObjectIds: [] }, vault.id))
      .toEqual({ outcome: "key-epoch-conflict" });
    expect(await coordinator.scopedHead()).toBeNull();
    expect(await coordinator.commitNamespaces({ ...delayed,
      updates: delayed.updates.map((update) => ({ ...update, keyEpoch: 2 })) }, vault.id))
      .toMatchObject({ outcome: "committed" });
    // Persistent intent remains authoritative when a prior D1 mutation has
    // an unknown outcome; a fresh stub must not reopen the old write epoch.
    await runInDurableObject(coordinator, async (_instance, state) => {
      expect(await state.storage.get(`key-epoch-floor:${vault.id}`)).toBe(2);
      await state.storage.put(`key-epoch-floor:${vault.id}`, 3);
    });
    const freshCoordinator = (env.VAULTS as DurableObjectNamespace<VaultCoordinator>).getByName(vault.id);
    expect(await freshCoordinator.commitNamespaces({ ...delayed,
      updates: delayed.updates.map((update) => ({ ...update, keyEpoch: 2 })) }, vault.id))
      .toEqual({ outcome: "key-epoch-conflict" });
    const completedRetry = await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/key-rotations`, {
      method: "POST", headers, body: JSON.stringify({ expectedEpoch: 2, newEpoch: 3,
        envelopes: [{ deviceId: "dev_rotation", envelope: "sealed-current-3" }, { deviceId: "dev_rotation_peer", envelope: "sealed-peer-3" }] }),
    });
    expect(completedRetry.status).toBe(201);
    expect(await freshCoordinator.commitNamespaces({ ...delayed, operationId: "op_retry_rotation", vaultRevisionId: "srev_retry_rotation",
      updates: delayed.updates.map((update) => ({ ...update, keyEpoch: 3,
        baseNamespaceRevisionId: "nrev_delayed_rotation", namespaceRevisionId: "nrev_retry_rotation" })) }, vault.id))
      .toMatchObject({ outcome: "committed" });

    // An infrastructure failure is not evidence that a client can delete its
    // candidate recovery kit. Preserve an ambiguous 5xx and the durable floor.
    await env.DB.prepare(`CREATE TRIGGER test_rotation_outage BEFORE INSERT ON vault_key_envelopes
      BEGIN SELECT RAISE(ABORT, 'injected infrastructure failure'); END`).run();
    const fourthRotation = { expectedEpoch: 3, newEpoch: 4,
      envelopes: [{ deviceId: "dev_rotation", envelope: "sealed-current-4" }, { deviceId: "dev_rotation_peer", envelope: "sealed-peer-4" }] };
    try {
      const failed = await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/key-rotations`, {
        method: "POST", headers, body: JSON.stringify(fourthRotation),
      });
      expect(failed.status).toBe(500);
    } finally {
      await env.DB.prepare("DROP TRIGGER test_rotation_outage").run();
    }
    expect(await env.DB.prepare("SELECT key_epoch FROM vaults WHERE id = ?").bind(vault.id).first("key_epoch")).toBe(3);
    expect(await freshCoordinator.commitNamespaces({ ...delayed,
      updates: delayed.updates.map((update) => ({ ...update, keyEpoch: 3 })) }, vault.id))
      .toEqual({ outcome: "key-epoch-conflict" });
    expect((await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/key-rotations`, {
      method: "POST", headers, body: JSON.stringify(fourthRotation),
    })).status).toBe(201);

    await env.DB.prepare("INSERT INTO devices (id, account_id, name, public_exchange_key, status, created_at, last_seen_at) VALUES (?, ?, ?, ?, 'active', ?, ?)")
      .bind("dev_replacement_rotation", account.accountId, "Replacement", peerPublicKey, now, now).run();
    const replacement = { ...issuer, deviceId: "dev_replacement_rotation" };
    await expect(env.DB.prepare("INSERT INTO vault_members (vault_id, device_id, role, created_at, enrolled_key_epoch) VALUES (?, ?, 'writer', ?, 1)")
      .bind(vault.id, replacement.deviceId, now).run()).rejects.toThrow("invalid vault enrollment epoch");
    await expect(services.control.joinVault(replacement, vault.id, 1)).rejects.toThrow("recovery kit epoch is stale");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM vault_members WHERE vault_id = ? AND device_id = ?")
      .bind(vault.id, replacement.deviceId).first("count")).toBe(0);
    expect(await services.control.joinVault(replacement, vault.id, 4)).toMatchObject({ role: "writer" });
    expect(await services.control.joinVault(issuer, vault.id, 4)).toMatchObject({ role: "owner" });
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

  it("rejects account creation outside the configured allowlist", async () => {
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
      body: JSON.stringify({ id: "dev_runtime", name: "Isolated workerd" }),
    });
    expect(registration.status).toBe(200);
    const registeredDevice = await registration.json() as { accountId: string; deviceId: string; name: string };
    expect(registeredDevice).toMatchObject({ name: "Isolated workerd" });

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

    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO devices (id, account_id, name, status, created_at, last_seen_at) VALUES (?, ?, ?, 'active', ?, ?)")
        .bind("dev_old_runtime", registeredDevice.accountId, "Old runtime", now - 1, now - 1),
      env.DB.prepare("INSERT INTO vault_members (vault_id, device_id, role, created_at) VALUES (?, ?, 'writer', ?)")
        .bind(vault.id, "dev_old_runtime", now - 1),
    ]);
    const devices = await exports.default.fetch("http://statecase.test/v1/devices", { headers: authenticated });
    expect(await devices.json()).toMatchObject({ devices: expect.arrayContaining([
      expect.objectContaining({ id: "dev_old_runtime", status: "active" }),
    ]) });
    expect((await exports.default.fetch("http://statecase.test/v1/devices/dev_unknown", { method: "DELETE", headers: authenticated })).status).toBe(404);
    expect((await exports.default.fetch("http://statecase.test/v1/devices/dev_old_runtime", { method: "DELETE", headers: authenticated })).status).toBe(204);
    expect(await env.DB.prepare("SELECT status FROM devices WHERE id = ?").bind("dev_old_runtime").first("status")).toBe("revoked");
    expect(await env.DB.prepare("SELECT revoked_at FROM vault_members WHERE device_id = ?").bind("dev_old_runtime").first("revoked_at")).toEqual(expect.any(Number));

    expect((await exports.default.fetch(`http://statecase.test/v1/devices/${registeredDevice.deviceId}`, { method: "DELETE", headers: authenticated })).status).toBe(204);
    expect((await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/head`, { headers: authenticated })).status).toBe(404);
    expect((await exports.default.fetch("http://statecase.test/v1/devices/current", {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify({ id: "dev_evasion", name: "Must not evade revocation" }),
    })).status).toBe(409);
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

  it("enforces a real single-use, namespace-scoped append capability through D1 and R2 (AU-003..AU-007)", async () => {
    const signup = await exports.default.fetch("http://statecase.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "capability@statecase.test", name: "Capability Operator", password: "a-strong-capability-password" }),
    });
    const deviceToken = signup.headers.get("set-auth-token");
    expect(deviceToken).toBeTruthy();
    const deviceHeaders = { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" };
    await exports.default.fetch("http://statecase.test/v1/devices/current", {
      method: "POST", headers: deviceHeaders, body: JSON.stringify({ id: "dev_capability", name: "Capability issuer" }),
    });
    const createdVault = await exports.default.fetch("http://statecase.test/v1/vaults", {
      method: "POST", headers: deviceHeaders, body: JSON.stringify({ name: "Scoped vault" }),
    });
    const vault = await createdVault.json() as { id: string };
    const bootstrapToken = `stc_boot_${randomBase64Url(32)}`;
    const capabilityId = "cap_runtime";
    const namespace = "workspace:runtime";
    const created = await exports.default.fetch("http://statecase.test/v1/tokens", {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({
        id: capabilityId,
        vaultId: vault.id,
        keyEpoch: 1,
        tokenHash: await sha256Base64Url(bootstrapToken),
        namespaces: [namespace],
        actions: ["read", "append"],
        expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        keyEnvelope: "opaque-e2ee-scope-keys",
      }),
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(await created.json())).not.toContain(bootstrapToken);

    const redemptionRequest = () => exports.default.fetch("http://statecase.test/api/bootstrap/redeem", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: bootstrapToken }),
    });
    const redemptions = await Promise.all([redemptionRequest(), redemptionRequest()]);
    expect(redemptions.map((response) => response.status).sort()).toEqual([200, 401]);
    const redeemed = redemptions.find((response) => response.status === 200)!;
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.get("cache-control")).toBe("no-store");
    const access = await redeemed.json() as { accessToken: string; keyEnvelope: string };
    expect(access).toMatchObject({ accessToken: expect.stringMatching(/^stc_access_/u), keyEnvelope: "opaque-e2ee-scope-keys" });
    const replayed = await redemptionRequest();
    expect(replayed.status).toBe(401);
    expect(replayed.headers.get("cache-control")).toBe("no-store");

    const capabilityHeaders = { authorization: `Bearer ${access.accessToken}`, "content-type": "application/octet-stream" };
    expect((await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/head`, { headers: capabilityHeaders })).status).toBe(404);
    const allowedBase = `http://statecase.test/v1/vaults/${vault.id}/namespaces/${encodeURIComponent(namespace)}/objects`;
    const forbiddenBase = `http://statecase.test/v1/vaults/${vault.id}/namespaces/${encodeURIComponent("drop:private")}/objects`;
    const manifestPut = await exports.default.fetch(`${allowedBase}/obj_manifest`, { method: "PUT", headers: capabilityHeaders, body: Uint8Array.of(1) });
    expect(manifestPut.status, await manifestPut.clone().text()).toBe(201);
    expect((await exports.default.fetch(`${allowedBase}/obj_chunk`, { method: "PUT", headers: capabilityHeaders, body: Uint8Array.of(2) })).status).toBe(201);
    expect((await exports.default.fetch(`${forbiddenBase}/obj_hidden`, { method: "PUT", headers: capabilityHeaders, body: Uint8Array.of(3) })).status).toBe(404);
    expect((await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/namespace-commits`, {
      method: "POST",
      headers: { authorization: `Bearer ${access.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "1.1", operationId: "op_replace_denied", vaultRevisionId: "rev_replace_denied",
        updates: [{
          namespace, baseNamespaceRevisionId: null, namespaceRevisionId: "nrev_replace_denied",
          manifestObjectId: "obj_manifest", requiredObjectIds: ["obj_chunk"], mode: "replace",
          pathClaims: [{ pathId: "pth_replace_denied", mutation: "add" }],
        }],
      }),
    })).status).toBe(404);
    const committed = await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/namespace-commits`, {
      method: "POST",
      headers: { authorization: `Bearer ${access.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "1.1",
        operationId: "op_capability_runtime",
        vaultRevisionId: "rev_capability_runtime",
        updates: [{
          namespace,
          baseNamespaceRevisionId: null,
          namespaceRevisionId: "nrev_capability_runtime",
          manifestObjectId: "obj_manifest",
          requiredObjectIds: ["obj_chunk"],
          mode: "append",
          pathClaims: [{ pathId: "pth_capability_runtime", mutation: "add" }],
        }],
      }),
    });
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ outcome: "committed" });
    expect(await (await exports.default.fetch(
      `http://statecase.test/v1/vaults/${vault.id}/scoped-revisions/rev_capability_runtime`,
      { headers: capabilityHeaders },
    )).json()).toMatchObject({
      revisionId: "rev_capability_runtime",
      namespaces: [{ namespace, revisionId: "nrev_capability_runtime", manifestObjectId: "obj_manifest", commitMode: "append" }],
    });
    expect(await (await exports.default.fetch(
      `http://statecase.test/v1/vaults/${vault.id}/namespaces/${encodeURIComponent(namespace)}/revisions/nrev_capability_runtime`,
      { headers: capabilityHeaders },
    )).json()).toMatchObject({ revisionId: "nrev_capability_runtime", previousRevisionId: null, commitMode: "append" });
    expect(await (await exports.default.fetch(
      `http://statecase.test/v1/vaults/${vault.id}/namespaces`, { headers: capabilityHeaders },
    )).json()).toMatchObject({ commitProvenance: 1, namespaces: [{ namespace, commitMode: "append" }] });
    expect((await exports.default.fetch(`http://statecase.test/v1/vaults/${vault.id}/namespace-commits`, {
      method: "POST",
      headers: { authorization: `Bearer ${access.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "1.1", operationId: "op_forbidden", vaultRevisionId: "rev_forbidden",
        updates: [{
          namespace: "drop:private", baseNamespaceRevisionId: null, namespaceRevisionId: "nrev_forbidden",
          manifestObjectId: "obj_hidden", requiredObjectIds: [], mode: "append", pathClaims: [],
        }],
      }),
    })).status).toBe(404);

    expect((await exports.default.fetch(`http://statecase.test/v1/tokens/${capabilityId}`, { method: "DELETE", headers: deviceHeaders })).status).toBe(204);
    expect((await exports.default.fetch(`${allowedBase}/obj_after_revoke`, { method: "PUT", headers: capabilityHeaders, body: Uint8Array.of(4) })).status).toBe(401);
  });

  it("persists Durable Object commits across stubs", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO statecase_accounts (id, created_at, status) VALUES ('acct_coordinator', 1, 'active')"),
      env.DB.prepare("INSERT INTO vaults (id, account_id, name, created_at, status) VALUES ('vlt_runtime', 'acct_coordinator', 'Coordinator fixture', 1, 'active')"),
    ]);
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
    expect(await firstStub.commit(request, "vlt_runtime")).toMatchObject({ outcome: "committed", revisionId: "rev_runtime" });
    expect(await vaults.getByName("vlt_runtime").head()).toEqual({
      revisionId: "rev_runtime",
      manifestObjectId: "obj_manifest",
    });
    expect(await firstStub.revision("rev_runtime")).toEqual({
      revisionId: "rev_runtime",
      manifestObjectId: "obj_manifest",
      previousRevisionId: null,
    });
    const snapshot = await firstStub.createSnapshot({ id: "snp_runtime", name: "Runtime checkpoint", createdAt: 1 });
    expect(snapshot).toMatchObject({ outcome: "created", snapshot: { revisionId: "rev_runtime", protected: true } });
    expect(await vaults.getByName("vlt_runtime").listSnapshots()).toHaveLength(1);
    expect(await firstStub.deleteSnapshot("snp_runtime")).toBe(true);
    expect(await firstStub.listSnapshots()).toEqual([]);
  });

  it("lists and deletes only unreachable scoped R2 objects through the real owner GC route (BK-003..BK-005)", async () => {
    const signup = await exports.default.fetch("http://statecase.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "gc@statecase.test", name: "GC Operator", password: "a-strong-gc-runtime-password" }),
    });
    expect(signup.status).toBe(200);
    const token = signup.headers.get("set-auth-token");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    await exports.default.fetch("http://statecase.test/v1/devices/current", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "dev_gc_runtime", name: "GC workerd" }),
    });
    const created = await exports.default.fetch("http://statecase.test/v1/vaults", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "GC vault" }),
    });
    const { id: vaultId } = await created.json() as { id: string };
    const namespace = "drop:gc-runtime";
    const base = `http://statecase.test/v1/vaults/${vaultId}/namespaces/${encodeURIComponent(namespace)}/objects`;
    for (const [objectId, byte] of [["obj_gc_manifest", 1], ["obj_gc_chunk", 2]] as const) {
      expect((await exports.default.fetch(`${base}/${objectId}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
        body: Uint8Array.of(byte),
      })).status).toBe(201);
    }
    const committed = await exports.default.fetch(`http://statecase.test/v1/vaults/${vaultId}/namespace-commits`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        protocolVersion: "1.1",
        operationId: "op_gc_runtime",
        vaultRevisionId: "srev_gc_runtime",
        updates: [{
          namespace,
          baseNamespaceRevisionId: null,
          namespaceRevisionId: "nrev_gc_runtime",
          manifestObjectId: "obj_gc_manifest",
          requiredObjectIds: ["obj_gc_chunk"],
          retainedVaultRevisionIds: ["srev_gc_runtime"],
          mode: "replace",
          pathClaims: [{ pathId: "pth_gc_runtime", mutation: "add" }],
        }],
      }),
    });
    expect(committed.status, await committed.clone().text()).toBe(200);
    expect((await exports.default.fetch(`${base}/obj_gc_orphan`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body: Uint8Array.of(3, 4, 5),
    })).status).toBe(201);
    const malformedShadowKey = `v1/vaults/${vaultId}/namespaces/${namespace}/objects/wrong-prefix/obj_gc_orphan`;
    await env.BLOBS.put(malformedShadowKey, Uint8Array.of(6));
    expect((await exports.default.fetch(`http://statecase.test/v1/vaults/${vaultId}/objects/obj_gc_legacy`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body: Uint8Array.of(9),
    })).status).toBe(201);

    const preview = await exports.default.fetch(`http://statecase.test/v1/vaults/${vaultId}/garbage-collection`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dryRun: true }),
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ dryRun: true, candidateObjects: 1, deletedObjects: 0, deleteBytes: 3 });
    expect((await exports.default.fetch(`${base}/obj_gc_orphan`, { headers })).status).toBe(200);

    const collected = await exports.default.fetch(`http://statecase.test/v1/vaults/${vaultId}/garbage-collection`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dryRun: false }),
    });
    expect(collected.status, await collected.clone().text()).toBe(200);
    expect(await collected.json()).toMatchObject({ dryRun: false, candidateObjects: 1, deletedObjects: 1, deleteBytes: 3 });
    expect((await exports.default.fetch(`${base}/obj_gc_orphan`, { headers })).status).toBe(404);
    expect(await env.BLOBS.head(malformedShadowKey)).not.toBeNull();
    expect((await exports.default.fetch(`${base}/obj_gc_manifest`, { headers })).status).toBe(200);
    expect((await exports.default.fetch(`${base}/obj_gc_chunk`, { headers })).status).toBe(200);
    expect((await exports.default.fetch(`http://statecase.test/v1/vaults/${vaultId}/objects/obj_gc_legacy`, { headers })).status).toBe(200);
  });

  it("provides an isolated R2 binding for opaque bytes", async () => {
    await env.BLOBS.put("v1/test/object", Uint8Array.of(7, 8, 9));
    const object = await env.BLOBS.get("v1/test/object");
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(Uint8Array.of(7, 8, 9));
  });
});

function randomBase64Url(size: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(size))).toString("base64url");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}
