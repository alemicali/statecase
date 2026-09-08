import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { ProfileLock } from "@statecase/runtime";
import type { LocalSecrets } from "../src/config.js";
import { CredentialFile, CredentialStorageError, type CredentialKeyProtector } from "../src/credentials.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const secrets = () => ({ version: 1 as const, token: "fixture-token-must-not-appear", vaultKeys: { vlt_fixture: "fixture-root-must-not-appear" } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "statecase-credentials-")); roots.push(root);
  const keys = new Map<string, Uint8Array>(); let calls = 0;
  const protector: CredentialKeyProtector = { backend: "secret-service",
    async get(id) { calls++; const key = keys.get(id); if (!key) throw new Error("private native diagnostic"); return key.slice(); },
    async put(id, key) { calls++; keys.set(id, key.slice()); } };
  return { root, keys, protector, calls: () => calls, path: join(root, "credentials.json") };
}

describe("OS-backed local credential protection (AU-012, AU-013, CR-011)", () => {
  it("rejects FIFO credentials without blocking on a writer", async () => {
    const f = await fixture(); await promisify(execFile)("mkfifo", ["-m", "600", f.path]);
    const store = new CredentialFile(f.root, { protector: f.protector });
    const read = store.read().then(() => "accepted", () => "rejected");
    const result = await Promise.race([read, new Promise<string>((accept) => setTimeout(() => accept("blocked"), 200))]);
    // Release a buggy blocking open before asserting; the test must not leave
    // a libuv worker waiting indefinitely or rely on deleting an open FIFO.
    const release = await open(f.path, constants.O_RDWR | constants.O_NONBLOCK); await release.close();
    await read; expect(result).toBe("rejected"); expect(f.calls()).toBe(0);
  });

  it("uses the same retrieved key to authenticate old credentials and protect their replacement", async () => {
    const f = await fixture(); const store = new CredentialFile(f.root, { protector: f.protector });
    await store.write(secrets()); await store.protect();
    const get = f.protector.get; let reads = 0;
    f.protector.get = async (id) => ++reads === 1 ? get(id) : new Uint8Array(32).fill(76);
    await store.write({ ...secrets(), token: "updated" });
    f.protector.get = get;
    expect(await store.read()).toEqual({ ...secrets(), token: "updated" }); expect(reads).toBe(1);
  });

  it("rejects unknown protected metadata instead of reporting a plaintext-bearing document as protected", async () => {
    const f = await fixture(); const store = new CredentialFile(f.root, { protector: f.protector });
    await store.write(secrets()); await store.protect(); const doc = JSON.parse(await readFile(f.path, "utf8"));
    await writeFile(f.path, JSON.stringify({ ...doc, token: "unprotected-canary" }));
    await expect(store.status()).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_INVALID" });
  });

  it("does not expose filesystem errors or remove a replaced credential lock", async () => {
    const f = await fixture(); await new CredentialFile(f.root).write(secrets()); const original = await readFile(f.path);
    const lock = join(f.root, "locks", "credentials.lock"); const canary = '{"private":"lock-diagnostic-canary';
    const store = new CredentialFile(f.root, { protector: f.protector, beforeCommit: async () => {
      await writeFile(lock, canary); throw new Error("private-commit-canary");
    } });
    const failure = await store.protect().catch((error: unknown) => error);
    expect(await readFile(lock, "utf8")).toBe(canary); expect(await readFile(f.path)).toEqual(original);
    expect(failure).toMatchObject({ code: "CREDENTIAL_COMMIT_FAILED" });
    expect(String(failure)).not.toContain("canary");
    const invalidHome = join(f.root, "private-path-canary"); await writeFile(invalidHome, "fixture");
    const invalid = await new CredentialFile(invalidHome).write(secrets()).catch((error: unknown) => error);
    expect(invalid).toMatchObject({ code: "CREDENTIAL_DOCUMENT_UNSAFE" }); expect(String(invalid)).not.toContain("canary");
  });

  it("does not create a missing profile during read/status/preview and can protect a fresh profile", async () => {
    const f = await fixture(); const home = join(f.root, "fresh");
    const store = new CredentialFile(home, { protector: f.protector });
    expect(await store.status()).toEqual({ backend: "file", protected: false, exists: false });
    expect(await store.read()).toEqual({ version: 1, vaultKeys: {} });
    expect(await store.protect({ dryRun: true })).toMatchObject({ changed: false, dryRun: true });
    expect(await readdir(f.root)).toEqual([]); expect(f.calls()).toBe(0);
    expect(await store.protect()).toMatchObject({ changed: true });
    expect(await store.read()).toEqual({ version: 1, vaultKeys: {} });
    const before = f.calls();
    expect(await store.status()).toEqual({ backend: "secret-service", protected: true, exists: true });
    await store.protect({ dryRun: true }); expect(f.calls()).toBe(before);
    expect(await store.protect()).toMatchObject({ changed: false, dryRun: false });
    expect(f.keys.size).toBe(1);
  });

  it("preserves exchange keys, historical keyrings, scoped keys and unknown future data exactly", async () => {
    const f = await fixture(); const store = new CredentialFile(f.root, { protector: f.protector });
    const value = { ...secrets(), deviceExchange: { publicKey: "public", privateKey: "private" },
      vaultKeyrings: { vlt_fixture: { currentEpoch: 2, keys: { 1: "old-root", 2: "new-root" } } },
      scopedVaults: { vlt_scoped: { vaultId: "vlt_scoped", keyEpoch: 2, namespaces: ["drop:fixture"], actions: ["read" as const],
        expiresAt: 1234, namespaceKeys: { "drop:fixture": { encryptionKey: "encryption", dedupKey: "dedup" } } } },
      futureField: { opaque: ["fixture-private", 4, null] } };
    await store.write(value); await store.protect();
    expect(await store.read()).toEqual(value);
    await store.write({ ...value, token: "replacement-token" });
    expect(await store.read()).toEqual({ ...value, token: "replacement-token" });
    const raw = await readFile(f.path, "utf8");
    for (const canary of ["private", "old-root", "new-root", "fixture-private", "replacement-token"]) expect(raw).not.toContain(canary);
  });

  it.each([null, [], {}, { version: 3, vaultKeys: {} }, { version: 1, vaultKeys: [] },
    { version: 1, vaultKeys: { fixture: 42 } }, { version: 1, vaultKeys: {}, token: 42 }])("rejects malformed legacy structure %j", async (value) => {
    const f = await fixture(); const encoded = JSON.stringify(value);
    await writeFile(f.path, encoded, { mode: 0o600 });
    const store = new CredentialFile(f.root, { protector: f.protector });
    await expect(store.read()).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_INVALID" });
    await expect(store.protect()).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_INVALID" });
    expect(await readFile(f.path, "utf8")).toBe(encoded); expect(f.calls()).toBe(0);
  });

  it("rejects malformed UTF-8, oversized reads/writes and circular serialization safely", async () => {
    const f = await fixture(); const store = new CredentialFile(f.root, { protector: f.protector });
    await writeFile(f.path, Buffer.from([0xff, 0xfe]), { mode: 0o600 });
    await expect(store.read()).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_INVALID" });
    await writeFile(f.path, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    await expect(store.read()).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_INVALID" });
    await rm(f.path); await store.write(secrets()); const original = await readFile(f.path);
    await expect(store.write({ ...secrets(), token: "x".repeat(8 * 1024 * 1024) })).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_INVALID" });
    const circular = { ...secrets(), self: undefined as unknown }; circular.self = circular;
    await expect(store.write(circular)).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_INVALID" });
    await expect(store.write({ version: 3 } as unknown as LocalSecrets)).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_INVALID" });
    expect(await readFile(f.path)).toEqual(original); expect(f.calls()).toBe(0);
  });

  it("refuses permissive modes, hard links and directory credentials without changing them", async () => {
    const f = await fixture(); const store = new CredentialFile(f.root, { protector: f.protector });
    await store.write(secrets()); await chmod(f.path, 0o640);
    await expect(store.read()).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_UNSAFE" });
    await chmod(f.path, 0o600); const other = join(f.root, "hardlink"); await link(f.path, other);
    await expect(store.protect()).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_UNSAFE" });
    await rm(f.path); await mkdir(f.path);
    await expect(store.read()).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_UNSAFE" });
    expect(JSON.parse(await readFile(other, "utf8"))).toEqual(secrets()); expect(f.calls()).toBe(0);
  });

  it("preserves another writer's lock and refuses a stale missing-file snapshot", async () => {
    const f = await fixture(); const store = new CredentialFile(f.root, { protector: f.protector });
    await store.read(); const foreign = await ProfileLock.acquire(join(f.root, "locks", "credentials.lock"));
    const lockBytes = await readFile(foreign.path);
    try {
      await expect(store.write(secrets())).rejects.toMatchObject({ code: "CREDENTIAL_STORE_LOCKED" });
      await expect(store.protect()).rejects.toMatchObject({ code: "CREDENTIAL_STORE_LOCKED" });
      expect(await readFile(foreign.path)).toEqual(lockBytes); expect(f.calls()).toBe(0);
    } finally { await foreign.release(); }
    await new CredentialFile(f.root, { protector: f.protector }).write(secrets());
    await expect(store.write(secrets())).rejects.toMatchObject({ code: "CREDENTIAL_STATE_CHANGED" });
  });

  it("retains original bytes and new key on precommit failure with redacted errors and no temporary file", async () => {
    const f = await fixture(); await new CredentialFile(f.root).write(secrets());
    const original = await readFile(f.path);
    const store = new CredentialFile(f.root, { protector: f.protector, beforeCommit: async () => { throw new Error(secrets().token); } });
    const failure = await store.protect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialStorageError);
    expect(failure).toMatchObject({ code: "CREDENTIAL_COMMIT_FAILED" });
    expect(JSON.stringify(failure)).not.toContain(secrets().token);
    expect(await readFile(f.path)).toEqual(original); expect(f.keys.size).toBe(1);
    expect((await readdir(f.root)).sort()).toEqual(["credentials.json", "locks"]);
    expect(await readdir(join(f.root, "locks"))).toEqual([]);
  });

  it("rejects an invalid backend key and wipes a wrongly sized owned buffer", async () => {
    const f = await fixture(); const invalid = new Uint8Array(31).fill(42);
    f.protector.get = async () => invalid;
    const store = new CredentialFile(f.root, { protector: f.protector }); await store.write(secrets());
    const original = await readFile(f.path);
    await expect(store.protect()).rejects.toMatchObject({ code: "CREDENTIAL_KEY_MISMATCH" });
    expect(invalid.every((byte) => byte === 0)).toBe(true); expect(await readFile(f.path)).toEqual(original);
    f.protector.get = async () => "wrong-type" as unknown as Uint8Array;
    await expect(store.protect()).rejects.toMatchObject({ code: "CREDENTIAL_KEY_MISMATCH" });
  });

  it("binds ciphertext to its opaque key reference even if both references resolve to the same key", async () => {
    const f = await fixture(); const store = new CredentialFile(f.root, { protector: f.protector });
    await store.write(secrets()); await store.protect();
    const doc = JSON.parse(await readFile(f.path, "utf8")); const keyId = `loc_${"f".repeat(32)}`;
    f.keys.set(keyId, f.keys.get(doc.keyId)!);
    await writeFile(f.path, JSON.stringify({ ...doc, keyId }));
    await expect(new CredentialFile(f.root, { protector: f.protector }).write(secrets())).rejects.toMatchObject({ code: "CREDENTIAL_INTEGRITY_FAILED" });
  });

  it("previews legacy protection without touching the backend or changing bytes", async () => {
    const f = await fixture(); const store = new CredentialFile(f.root, { protector: f.protector });
    await store.write(secrets()); const original = await readFile(f.path);
    expect(await store.protect({ dryRun: true })).toMatchObject({ changed: false, dryRun: true, backend: "secret-service" });
    expect(f.calls()).toBe(0); expect(await readFile(f.path)).toEqual(original);
  });

  it("protects and updates an existing profile without plaintext secrets or wrapping keys in the file", async () => {
    const f = await fixture(); const store = new CredentialFile(f.root, { protector: f.protector });
    await store.write(secrets());
    expect(await store.protect()).toMatchObject({ changed: true, backend: "secret-service" });
    const encoded = await readFile(f.path, "utf8"); const document = JSON.parse(encoded);
    expect(document.version).toBe(2); expect(f.keys.size).toBe(1);
    for (const value of [secrets().token, secrets().vaultKeys.vlt_fixture, Buffer.from([...f.keys.values()][0]!).toString("base64url")]) expect(encoded).not.toContain(value);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    const reopened = new CredentialFile(f.root, { protector: f.protector });
    expect(await reopened.read()).toEqual(secrets());
    await reopened.write({ ...secrets(), token: "updated-fixture-token" });
    expect((await new CredentialFile(f.root, { protector: f.protector }).read()).token).toBe("updated-fixture-token");
    expect(JSON.parse(await readFile(f.path, "utf8")).keyId).toBe(document.keyId);
  });

  it("preserves the exact legacy file when the native store fails or read-back is wrong", async () => {
    const f = await fixture(); const store = new CredentialFile(f.root, { protector: f.protector });
    await store.write(secrets()); const original = await readFile(f.path);
    f.protector.put = async () => { throw new Error(secrets().token); };
    await expect(store.protect()).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    expect(await readFile(f.path)).toEqual(original);
    f.protector.put = async () => undefined;
    f.protector.get = async () => new Uint8Array(32);
    await expect(store.protect()).rejects.toMatchObject({ code: "CREDENTIAL_KEY_MISMATCH" });
    expect(await readFile(f.path)).toEqual(original);
  });

  it("never falls back to plaintext on missing keys, corrupt envelopes, or backend substitution", async () => {
    const f = await fixture(); const store = new CredentialFile(f.root, { protector: f.protector });
    await store.write(secrets()); await store.protect(); const encoded = await readFile(f.path, "utf8");
    const doc = JSON.parse(encoded); const saved = f.keys.get(doc.keyId)!; f.keys.clear();
    await expect(store.read()).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    await expect(store.write(secrets())).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    expect(await readFile(f.path, "utf8")).toBe(encoded);
    f.keys.set(doc.keyId, saved);
    const envelope = Buffer.from(doc.envelope, "base64url"); envelope[envelope.length - 1] ^= 1;
    await writeFile(f.path, JSON.stringify({ ...doc, envelope: envelope.toString("base64url") }));
    await expect(new CredentialFile(f.root, { protector: f.protector }).read()).rejects.toMatchObject({ code: "CREDENTIAL_INTEGRITY_FAILED" });
    await writeFile(f.path, JSON.stringify({ ...doc, backend: "unknown-native-store" }));
    await expect(store.read()).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_INVALID" });
  });

  it("rejects stale saves and source changes during migration without replacing independent work", async () => {
    const f = await fixture(); const a = new CredentialFile(f.root, { protector: f.protector });
    await a.write(secrets()); const b = new CredentialFile(f.root, { protector: f.protector });
    await a.read(); await b.read(); await b.write({ ...secrets(), token: "newer-work" });
    await expect(a.write(secrets())).rejects.toMatchObject({ code: "CREDENTIAL_STATE_CHANGED" });
    const changed = JSON.stringify({ ...secrets(), token: "independent-during-migration" });
    const raced = new CredentialFile(f.root, { protector: f.protector, beforeCommit: async () => { await writeFile(f.path, changed); } });
    await expect(raced.protect()).rejects.toMatchObject({ code: "CREDENTIAL_STATE_CHANGED" });
    expect(await readFile(f.path, "utf8")).toBe(changed); expect(f.keys.size).toBe(1);
  });

  it("rejects malformed and linked credential documents without exposing their contents", async () => {
    const f = await fixture();
    await writeFile(f.path, `{"token":"${secrets().token}`, { mode: 0o600 });
    await expect(new CredentialFile(f.root, { protector: f.protector }).read()).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_INVALID" });
    await rm(f.path); const target = join(f.root, "other.json");
    await writeFile(target, JSON.stringify(secrets()), { mode: 0o600 }); await symlink(target, f.path);
    await expect(new CredentialFile(f.root, { protector: f.protector }).read()).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_UNSAFE" });
    await expect(new CredentialFile(f.root, { protector: f.protector }).write(secrets())).rejects.toMatchObject({ code: "CREDENTIAL_DOCUMENT_UNSAFE" });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(secrets()); expect(f.calls()).toBe(0);
  });
});
