import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { deriveRecoveryKey, encryptEnvelope, randomKey } from "@statecase/crypto";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../src/config.js";
import { ProfileLock } from "@statecase/runtime";
import { readRecoveryKeyringKit, readRecoveryKit, writeRecoveryKeyringKit, writeRecoveryKit } from "../src/recovery.js";

const temporary: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CLI local security and recovery (CR-007, CR-009, AU-011)", () => {
  it("uses the conventional owner-local home when no override is configured", () => {
    const previous = process.env.STATECASE_HOME;
    delete process.env.STATECASE_HOME;
    try {
      expect(new ConfigStore().home).toBe(join(homedir(), ".statecase"));
    } finally {
      if (previous === undefined) delete process.env.STATECASE_HOME;
      else process.env.STATECASE_HOME = previous;
    }
  });

  it("writes configuration and credentials atomically with owner-only permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-config-"));
    temporary.push(home);
    const store = new ConfigStore(home);
    await store.saveConfig({ version: 1, apiUrl: "https://example.test", mappings: [], workspaces: [], applied: {} });
    await store.saveSecrets({ version: 1, token: "do-not-print", vaultKeys: { vlt_one: "secret" } });
    if (process.platform !== "win32") {
      expect((await stat(join(home, "config.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, "credentials.json"))).mode & 0o777).toBe(0o600);
    }
    expect((await store.loadSecrets()).token).toBe("do-not-print");
  });

  it("fails closed instead of replacing malformed local configuration", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-malformed-config-"));
    temporary.push(home);
    await writeFile(join(home, "config.json"), "{not-json", "utf8");
    await expect(new ConfigStore(home).loadConfig()).rejects.toMatchObject({ code: "PROFILE_INVALID" });
  });

  it("rejects stale concurrent configuration saves without losing memory bindings or applied revisions (AD-MEM-007)", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-config-concurrent-")); temporary.push(home);
    const first = new ConfigStore(home), second = new ConfigStore(home);
    const a = await first.loadConfig(), b = await second.loadConfig();
    a.deviceName = "first"; await first.saveConfig(a);
    b.deviceName = "stale";
    await expect(second.saveConfig(b)).rejects.toMatchObject({ code: "CONFIG_STATE_CHANGED" });
    expect((await first.loadConfig()).deviceName).toBe("first");
    const c = await first.loadConfig(), d = await second.loadConfig();
    c.applied["memory:recall"] = { revisionId: "nrev_one", digests: {} }; await first.saveConfig(c);
    d.memories = [];
    await expect(second.saveConfig(d)).rejects.toMatchObject({ code: "CONFIG_STATE_CHANGED" });
    c.deviceName = "next"; await first.saveConfig(c);
    expect((await second.loadConfig()).applied).toEqual(c.applied);
    await expect(second.saveConfig({ ...c, deviceName: "unobserved" })).rejects.toMatchObject({ code: "CONFIG_STATE_CHANGED" });
  });
  it("admits one concurrent configuration writer and preserves config while the mutex is held (AD-MEM-007)", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-config-writers-")); temporary.push(home);
    const store = new ConfigStore(home), initial = await store.loadConfig(); await store.saveConfig(initial);
    const lock = await ProfileLock.acquire(join(home, "config.lock"));
    try { await expect(store.saveConfig(initial)).rejects.toMatchObject({ code: "CONFIG_STATE_CHANGED" }); }
    finally { await lock.release(); }
    const configs = await Promise.all(Array.from({ length: 8 }, () => store.loadConfig()));
    const results = await Promise.allSettled(configs.map((config, index) => { config.deviceName = `writer-${index}`; return store.saveConfig(config); }));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.loadConfig()).deviceName).toBe(`writer-${results.findIndex((result) => result.status === "fulfilled")}`);
  });

  it("round-trips a passphrase-protected kit and rejects the wrong vault or passphrase", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-recovery-"));
    temporary.push(home);
    const path = join(home, "recovery.json");
    const key = await randomKey();
    await writeRecoveryKit(path, "vlt_one", key, "correct horse battery staple");
    expect(await readRecoveryKit(path, "vlt_one", "correct horse battery staple")).toEqual(key);
    expect(await readRecoveryKeyringKit(path, "vlt_one", "correct horse battery staple")).toEqual({ currentEpoch: 1, keys: { 1: key } });
    await expect(readRecoveryKit(path, "vlt_two", "correct horse battery staple")).rejects.toThrow(/does not match/u);
    await expect(readRecoveryKit(path, "vlt_one", "a completely wrong password")).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(await readFile(path, "utf8")).not.toContain(Buffer.from(key).toString("base64url"));
  });

  it("preserves every historical vault-key epoch in a versioned encrypted recovery kit (CR-009, CR-010)", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-recovery-keyring-"));
    temporary.push(home);
    const path = join(home, "recovery-v2.json");
    const first = new Uint8Array(32).fill(1);
    const second = new Uint8Array(32).fill(2);
    await writeRecoveryKeyringKit(path, "vlt_one", { currentEpoch: 2, keys: { 1: first, 2: second } }, "correct horse battery staple");

    const restored = await readRecoveryKeyringKit(path, "vlt_one", "correct horse battery staple");
    expect(restored).toEqual({ currentEpoch: 2, keys: { 1: first, 2: second } });
    expect(await readRecoveryKit(path, "vlt_one", "correct horse battery staple")).toEqual(second);
    const serialized = await readFile(path, "utf8");
    expect(serialized).not.toContain(Buffer.from(first).toString("base64url"));
    expect(serialized).not.toContain(Buffer.from(second).toString("base64url"));
    await expect(writeRecoveryKeyringKit(join(home, "invalid.json"), "vlt_one", { currentEpoch: 2, keys: { 1: first } }, "correct horse battery staple"))
      .rejects.toThrow("current epoch");
  });

  it("rejects malformed encrypted keyring payloads without accepting partial history (CR-010)", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-recovery-malformed-"));
    temporary.push(home);
    const encodedKey = Buffer.alloc(32, 4).toString("base64url");
    const fixtures: Array<[string, unknown, string]> = [
      ["scalar", null, "malformed"],
      ["wrong-version", { version: 2, currentEpoch: 1, keys: { 1: encodedKey } }, "malformed"],
      ["empty", { version: 1, currentEpoch: 1, keys: {} }, "malformed"],
      ["invalid-epoch", { version: 1, currentEpoch: 1, keys: { 1: encodedKey, "-1": encodedKey } }, "malformed"],
      ["invalid-key", { version: 1, currentEpoch: 1, keys: { 1: "a" } }, "malformed"],
      ["missing-current", { version: 1, currentEpoch: 2, keys: { 1: encodedKey } }, "current epoch"],
    ];
    for (const [name, payload, message] of fixtures) {
      const path = join(home, `${name}.json`);
      await writeEncryptedKeyringPayload(path, payload);
      await expect(readRecoveryKeyringKit(path, "vlt_one", "correct horse battery staple")).rejects.toThrow(message);
    }

    const invalidOuter = join(home, "invalid-outer.json");
    await writeFile(invalidOuter, JSON.stringify({ version: 3, vaultId: "vlt_one", salt: "salt", envelope: "envelope" }));
    await expect(readRecoveryKeyringKit(invalidOuter, "vlt_one", "correct horse battery staple")).rejects.toThrow("does not match");

    const tooManyKeys = Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [index + 1, new Uint8Array(32)]));
    await expect(writeRecoveryKeyringKit(join(home, "too-many.json"), "vlt_one", { currentEpoch: 1, keys: tooManyKeys }, "correct horse battery staple"))
      .rejects.toThrow("size");
    await expect(writeRecoveryKeyringKit(join(home, "bad-history.json"), "vlt_one", {
      currentEpoch: 1,
      keys: { 1: new Uint8Array(32), 2: new Uint8Array(31) },
    }, "correct horse battery staple")).rejects.toThrow("invalid epoch");
  // Each malformed payload is encrypted and decrypted with production Argon2id.
  }, 30_000);
});

async function writeEncryptedKeyringPayload(path: string, payload: unknown): Promise<void> {
  const salt = randomBytes(16);
  const recoveryKey = await deriveRecoveryKey("correct horse battery staple", salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  try {
    const envelope = await encryptEnvelope({
      plaintext,
      key: recoveryKey,
      dedupKey: recoveryKey,
      context: { vaultId: "vlt_one", scopeId: "recovery-keyring", compression: "none" },
    });
    await writeFile(path, JSON.stringify({
      version: 2,
      vaultId: "vlt_one",
      salt: Buffer.from(salt).toString("base64url"),
      envelope: Buffer.from(envelope).toString("base64url"),
    }));
  } finally {
    plaintext.fill(0);
    recoveryKey.fill(0);
  }
}
