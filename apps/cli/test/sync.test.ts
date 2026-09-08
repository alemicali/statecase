import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { computeObjectId, decryptEnvelope, deriveScopeKey, encryptEnvelope, randomKey } from "@statecase/crypto";
import { canonicalJson, namespaceManifestSchema, type NamespaceManifestV1 } from "@statecase/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatecaseClient } from "../src/client.js";
import { sessionBindingKey, type LocalConfig, type RootMapping } from "../src/config.js";
import { createEmergencySnapshot, restoreEmergencySnapshot } from "../src/emergency.js";
import { SyncConflict, SyncEngine, type VaultKeyring } from "../src/sync.js";
import * as streamTransfer from "../src/stream-transfer.js";
import * as appendMerge from "../src/append-merge-file.js";
import * as materialization from "../src/materialize.js";

const temporary: string[] = [];
const runFile = promisify(execFile);
afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("two-device encrypted synchronization (SY-001, SY-010, DR-001, WS-001, WS-003, WS-004)", () => {
  it("keeps conflict diagnostics stable for plural paths and empty legacy heads", async () => {
    expect(new SyncConflict(["a", "b"]).message).toContain("2 paths");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const root = await mkdtemp(join(tmpdir(), "statecase-empty-legacy-"));
    temporary.push(root);
    const local = config(root);
    delete local.deviceName;
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "device", remote.fetch), "vlt_test", key);
    expect(await engine.pull(local)).toMatchObject({ outcome: "unchanged", revisionId: null });
    expect(await engine.push(local)).toMatchObject({ outcome: "unchanged", revisionId: null, objects: 0 });
    await writeFile(join(root, "anonymous.txt"), "anonymous\n");
    expect(await engine.push(local)).toMatchObject({ outcome: "pushed" });
  });

  it("moves only safe encrypted Drop content between unrelated absolute paths", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-sync-"));
    temporary.push(base);
    const first = join(base, "machine-a", "notes");
    const second = join(base, "machine-b", "different", "notes");
    const outside = join(base, "outside.txt");
    await mkdir(join(first, "nested"), { recursive: true });
    await writeFile(join(first, "nested", "context.md"), "portable context\n");
    await writeFile(join(first, ".env"), "API_KEY=must-not-leak\n");
    const recoveryNames = ["backup", "staged"].flatMap((suffix) => {
      const name = `context.md.statecase-transaction-abcdef12-abcd-4bcd-8bcd-abcdef123456.${suffix}`;
      return [name, name.toUpperCase()];
    });
    recoveryNames.push("daemon.lock.statecase-lock.sqlite", "DAEMON.LOCK.STATECASE-LOCK.SQLITE",
      "daemon.lock.statecase-lock.sqlite-journal", "daemon.lock.statecase-lock.sqlite.owned.tmp");
    for (const name of recoveryNames) await writeFile(join(first, "nested", name), "local-only recovery plaintext\n");
    await writeFile(outside, "outside\n");
    await symlink(outside, join(first, "link.txt"));

    const remote = new MemoryRemote();
    const key = await randomKey();
    const a = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const b = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const configA = config(first);
    const configB = config(second);

    expect(await a.push(configA)).toMatchObject({ outcome: "pushed", files: 1 });
    expect(remote.namespaceHeads.get("drop:drop_shared")).toMatchObject({ namespace: "drop:drop_shared", manifestObjectId: expect.stringMatching(/^obj_/u) });
    expect(remote.plaintext).not.toContain("portable context");
    expect(remote.plaintext).not.toContain("must-not-leak");
    expect(await b.pull(configB)).toMatchObject({ outcome: "pulled", files: 1 });
    expect(await readFile(join(second, "nested", "context.md"), "utf8")).toBe("portable context\n");
    await expect(readFile(join(second, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(second, "link.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const name of recoveryNames) await expect(readFile(join(second, "nested", name))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await b.pull(configB)).outcome).toBe("unchanged");
  });

  it.each([false, true])("re-encrypts old namespaces (implicit legacy epoch: %s) and denies the old key future content (CR-010)", async (legacyEpoch) => {
    const base = await mkdtemp(join(tmpdir(), "statecase-key-epoch-"));
    temporary.push(base);
    const source = join(base, "source");
    const activeTarget = join(base, "active-target");
    const revokedTarget = join(base, "revoked-target");
    await Promise.all([mkdir(source), mkdir(activeTarget), mkdir(revokedTarget)]);
    await writeFile(join(source, "context.txt"), "before rotation\n");
    const remote = new MemoryRemote();
    const oldKey = await randomKey();
    const newKey = await randomKey();
    const client = new StatecaseClient("https://remote.test", "device", remote.fetch);
    const sourceConfig = config(source);
    const activeConfig = config(activeTarget);

    await new SyncEngine(client, "vlt_test", { currentEpoch: 1, keys: { 1: oldKey } }).push(sourceConfig);
    expect(remote.namespaceHeads.get("drop:drop_shared")).toMatchObject({ keyEpoch: 1 });
    if (legacyEpoch) {
      const head = remote.namespaceHeads.get("drop:drop_shared")!;
      const manifest = await readTestNamespaceManifest(remote, oldKey, head);
      delete manifest.keyEpoch;
      for (const entry of manifest.entries) delete entry.keyEpoch;
      const legacyHead = { namespace: head.namespace, revisionId: head.revisionId,
        manifestObjectId: await storeNamespaceManifest(remote, oldKey, manifest) };
      remote.namespaceHeads.set(head.namespace, legacyHead);
      remote.namespaceRevisions.set(`${head.namespace}\0${head.revisionId}`, { ...legacyHead, previousRevisionId: null });
      const checkpoint = remote.scopedRevisions.get(remote.scopedRevisionId!)!;
      checkpoint.namespaces = [legacyHead];
    }
    await new SyncEngine(client, "vlt_test", { currentEpoch: 2, keys: { 1: oldKey, 2: newKey } }).pull(activeConfig);
    expect(activeConfig.applied["drop:drop_shared"]).toMatchObject({ keyEpoch: 1 });

    await writeFile(join(source, "context.txt"), "after rotation\n");
    await new SyncEngine(client, "vlt_test", { currentEpoch: 2, keys: { 1: oldKey, 2: newKey } }).push(sourceConfig);
    expect(remote.namespaceHeads.get("drop:drop_shared")).toMatchObject({ keyEpoch: 2 });
    await expect(new SyncEngine(client, "vlt_test", oldKey).pull(config(revokedTarget)))
      .rejects.toThrow("vault key epoch 2 is unavailable");

    await expect(new SyncEngine(client, "vlt_test", { currentEpoch: 2, keys: { 1: oldKey, 2: newKey } }).pull(activeConfig))
      .resolves.toMatchObject({ outcome: "pulled" });
    expect(await readFile(join(activeTarget, "context.txt"), "utf8")).toBe("after rotation\n");
    expect(activeConfig.applied["drop:drop_shared"]).toMatchObject({ keyEpoch: 2 });
  });

  it("merges offline disjoint edits across a root-key rotation and keeps dry-run non-mutating (CR-010, SY-002)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-offline-rotation-"));
    temporary.push(base);
    const aRoot = join(base, "a");
    const bRoot = join(base, "b");
    await Promise.all([mkdir(aRoot), mkdir(bRoot)]);
    await writeFile(join(aRoot, "first.txt"), "first\n");
    await writeFile(join(aRoot, "second.txt"), "second\n");
    const aConfig = config(aRoot);
    const bConfig = config(bRoot);
    const remote = new MemoryRemote();
    const client = new StatecaseClient("https://remote.test", "device", remote.fetch);
    const oldKey = await randomKey();
    const oldEngine = new SyncEngine(client, "vlt_test", oldKey);
    await oldEngine.push(aConfig);
    await oldEngine.pull(bConfig);
    const keys = { currentEpoch: 2, keys: { 1: oldKey, 2: await randomKey() } };
    const engine = new SyncEngine(client, "vlt_test", keys);
    await writeFile(join(aRoot, "first.txt"), "owner changed first\n");
    const beforeOwnerPreview = remote.namespaceObjects.size;
    await expect(engine.push(aConfig, true)).resolves.toMatchObject({ outcome: "pushed" });
    expect(remote.namespaceObjects.size).toBe(beforeOwnerPreview);
    await engine.push(aConfig);
    await writeFile(join(bRoot, "second.txt"), "offline changed second\n");
    const beforeDryRun = remote.namespaceObjects.size;
    const beforeHead = remote.scopedRevisionId;
    await expect(engine.push(bConfig, true)).resolves.toMatchObject({ outcome: "pushed" });
    expect(remote.namespaceObjects.size).toBe(beforeDryRun);
    expect(remote.scopedRevisionId).toBe(beforeHead);
    await expect(engine.push(bConfig)).resolves.toMatchObject({ outcome: "pushed" });
    await engine.pull(bConfig);
    await engine.pull(aConfig);
    for (const root of [aRoot, bRoot]) {
      expect(await readFile(join(root, "first.txt"), "utf8")).toBe("owner changed first\n");
      expect(await readFile(join(root, "second.txt"), "utf8")).toBe("offline changed second\n");
    }
  });

  it("rekeys a deleted namespace without resurrecting files or emitting repeated no-op revisions (CR-010, SY-010)", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-empty-rotation-"));
    temporary.push(root);
    const remote = new MemoryRemote();
    const client = new StatecaseClient("https://remote.test", "device", remote.fetch);
    const key = await randomKey();
    const local = config(root);
    const before = new SyncEngine(client, "vlt_test", key);
    await writeFile(join(root, "deleted.txt"), "delete before rotation\n");
    await before.push(local);
    await rm(join(root, "deleted.txt"));
    await before.push(local);
    const oldHead = remote.scopedRevisionId;
    const after = new SyncEngine(client, "vlt_test", { currentEpoch: 2, keys: { 1: key, 2: await randomKey() } });
    await expect(after.push(local, true)).resolves.toMatchObject({ outcome: "pushed" });
    expect(remote.scopedRevisionId).toBe(oldHead);
    await expect(after.push(local)).resolves.toMatchObject({ outcome: "pushed" });
    expect(remote.namespaceHeads.get("drop:drop_shared")).toMatchObject({ keyEpoch: 2 });
    await expect(after.push(local)).resolves.toMatchObject({ outcome: "unchanged" });
    await expect(readFile(join(root, "deleted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materializes an authorized namespace without a vault root key or legacy object access", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-scoped-pull-"));
    temporary.push(base);
    const source = join(base, "source");
    const target = join(base, "target");
    await Promise.all([mkdir(source), mkdir(target)]);
    await writeFile(join(source, "brief.md"), "scoped context\n");
    const remote = new MemoryRemote();
    const rootKey = await randomKey();
    await new SyncEngine(new StatecaseClient("https://remote.test", "device", remote.fetch), "vlt_test", rootKey).push(config(source));
    const keys = await deriveScopeKey(rootKey, "drop:drop_shared");
    remote.allowLegacyReads = false;
    const scoped = new SyncEngine(new StatecaseClient("https://remote.test", "capability", remote.fetch), "vlt_test", {
      vaultId: "vlt_test",
      namespaces: ["drop:drop_shared"],
      actions: ["read"],
      expiresAt: Date.now() + 60_000,
      namespaceKeys: {
        "drop:drop_shared": {
          encryptionKey: Buffer.from(keys.encryptionKey).toString("base64url"),
          dedupKey: Buffer.from(keys.dedupKey).toString("base64url"),
        },
      },
    });
    expect(await scoped.pull(config(target))).toMatchObject({ outcome: "pulled", files: 1 });
    expect(await readFile(join(target, "brief.md"), "utf8")).toBe("scoped context\n");
  });

  it("publishes immutable append deltas and reconstructs them over the namespace snapshot", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-scoped-append-"));
    temporary.push(base);
    const source = join(base, "source");
    const sandbox = join(base, "sandbox");
    const observer = join(base, "observer");
    await Promise.all([mkdir(source), mkdir(sandbox), mkdir(observer)]);
    await writeFile(join(source, "brief.md"), "version one\n");
    const remote = new MemoryRemote();
    const rootKey = await randomKey();
    await new SyncEngine(new StatecaseClient("https://remote.test", "device", remote.fetch), "vlt_test", rootKey).push(config(source));
    const keys = await deriveScopeKey(rootKey, "drop:drop_shared");
    const access = {
      vaultId: "vlt_test",
      namespaces: ["drop:drop_shared"],
      actions: ["read", "append"] as Array<"read" | "append">,
      expiresAt: Date.now() + 60_000,
      namespaceKeys: { "drop:drop_shared": { encryptionKey: Buffer.from(keys.encryptionKey).toString("base64url"), dedupKey: Buffer.from(keys.dedupKey).toString("base64url") } },
    };
    remote.allowLegacyReads = false;
    const sandboxConfig = config(sandbox);
    const sandboxEngine = new SyncEngine(new StatecaseClient("https://remote.test", "capability", remote.fetch), "vlt_test", access);
    await sandboxEngine.pull(sandboxConfig);
    await writeFile(join(sandbox, "brief.md"), "version two\n");
    await writeFile(join(sandbox, "result.md"), "new result\n");
    expect(await sandboxEngine.push(sandboxConfig)).toMatchObject({ outcome: "pushed", files: 2 });

    const observerEngine = new SyncEngine(new StatecaseClient("https://remote.test", "capability", remote.fetch), "vlt_test", access);
    expect(await observerEngine.pull(config(observer))).toMatchObject({ outcome: "pulled", files: 2 });
    expect(await readFile(join(observer, "brief.md"), "utf8")).toBe("version two\n");
    expect(await readFile(join(observer, "result.md"), "utf8")).toBe("new result\n");
  });

  it("refuses to overwrite a locally modified file", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-conflict-"));
    temporary.push(base);
    const first = join(base, "a");
    const second = join(base, "b");
    await Promise.all([mkdir(first), mkdir(second)]);
    await writeFile(join(first, "file.txt"), "version one");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const a = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const b = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const configA = config(first);
    const configB = config(second);
    await a.push(configA);
    await b.pull(configB);
    await writeFile(join(second, "file.txt"), "local unsent edit");
    await writeFile(join(first, "file.txt"), "remote edit");
    await a.push(configA);
    await expect(b.pull(configB)).rejects.toBeInstanceOf(SyncConflict);
    expect(await readFile(join(second, "file.txt"), "utf8")).toBe("local unsent edit");
  });

  it("propagates deletion tombstones without silently deleting a modified destination (SY-006)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-delete-"));
    temporary.push(base);
    const first = join(base, "a");
    const second = join(base, "b");
    await Promise.all([mkdir(first), mkdir(second)]);
    await writeFile(join(first, "obsolete.txt"), "original");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const a = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const b = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const configA = config(first);
    const configB = config(second);
    await a.push(configA);
    await b.pull(configB);

    await rm(join(first, "obsolete.txt"));
    await a.push(configA);
    await b.pull(configB);
    await expect(readFile(join(second, "obsolete.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(join(first, "protected.txt"), "original");
    await a.push(configA);
    await b.pull(configB);
    await writeFile(join(second, "protected.txt"), "local edit");
    await rm(join(first, "protected.txt"));
    await a.push(configA);
    await expect(b.pull(configB)).rejects.toBeInstanceOf(SyncConflict);
    expect(await readFile(join(second, "protected.txt"), "utf8")).toBe("local edit");
  });

  it("refuses a first push over an existing remote namespace that was never pulled", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-unhydrated-"));
    temporary.push(base);
    const first = join(base, "a");
    const emptySecond = join(base, "b");
    await Promise.all([mkdir(first), mkdir(emptySecond)]);
    await writeFile(join(first, "valuable.txt"), "must survive");
    const remote = new MemoryRemote();
    const key = await randomKey();
    await new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key).push(config(first));

    await expect(new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key).push(config(emptySecond)))
      .rejects.toBeInstanceOf(SyncConflict);
  });

  it.each(["skills/new/SKILL.md", "future-context/v2/preferences.json"])("does not acknowledge or later delete unhydrated %s when another namespace commits (SY-011)", async (remotePath) => {
    const base = await mkdtemp(join(tmpdir(), "statecase-unhydrated-multiscope-"));
    temporary.push(base);
    const first = join(base, "first");
    const publisher = join(base, "publisher");
    const drop = join(base, "drop");
    await Promise.all([mkdir(join(first, "skills", "base"), { recursive: true }), mkdir(publisher), mkdir(drop)]);
    await writeFile(join(first, "skills", "base", "SKILL.md"), "base skill\n");
    await writeFile(join(drop, "note.txt"), "base note\n");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const local = harnessConfig(first, join(base, "unused-workspace"));
    local.mappings.push(config(drop).mappings[0]!);
    await engine.push(local);
    const namespace = "harness:codex:default";
    const actualApplied = structuredClone(local.applied[namespace]);

    // A synthetic newer adapter publishes an entry the original peer has not
    // pulled. Drop classification here emulates a newer harness allowlist.
    const newer = harnessConfig(publisher, join(base, "unused-workspace"));
    newer.mappings[0]!.kind = "drop";
    await engine.pull(newer);
    await mkdir(join(publisher, remotePath, ".."), { recursive: true });
    await writeFile(join(publisher, remotePath), "remote-only context\n");
    await engine.push(newer);
    const remoteHead = structuredClone(remote.namespaceHeads.get(namespace));

    await writeFile(join(drop, "note.txt"), "unrelated edit\n");
    expect((await engine.push(local)).outcome).toBe("pushed");
    expect(remote.namespaceHeads.get(namespace)).toEqual(remoteHead);
    expect((await engine.push(local)).outcome).toBe("unchanged");
    expect(remote.namespaceHeads.get(namespace)).toEqual(remoteHead);
    expect(local.applied[namespace]).toEqual(actualApplied);

    if (remotePath.startsWith("skills/")) {
      await engine.pull(local);
      expect(await readFile(join(first, remotePath), "utf8")).toBe("remote-only context\n");
      expect(local.applied[namespace]?.revisionId).toBe(remoteHead!.revisionId);
    } else {
      await expect(engine.pull(local)).rejects.toThrow();
      expect(local.applied[namespace]).toEqual(actualApplied);
      await expect(readFile(join(first, remotePath))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(["codex", "claude"] as const)("syncs %s preferences by field, preserving local secrets and unrelated concurrent edits (AD-CFG-007)", async (kind) => {
    const base = await mkdtemp(join(tmpdir(), "statecase-native-settings-sync-")); temporary.push(base);
    const first = join(base, "first"), second = join(base, "second");
    await Promise.all([mkdir(first, { mode: 0o700 }), mkdir(second, { mode: 0o700 })]);
    const filename = kind === "codex" ? "config.toml" : "settings.json";
    const document = (model: string | undefined, display: boolean, secret: string) => kind === "codex"
      ? `${model ? `model="${model}"\n` : ""}secret="${secret}"\n[tui]\nanimations=${display}\n`
      : JSON.stringify({ ...(model ? { model } : {}), verbose: display, env: { TOKEN: secret } });
    await writeFile(join(first, filename), document("fixture", false, "source-canary"), { mode: 0o600 });
    await writeFile(join(second, filename), kind === "codex" ? 'secret="target-canary"\n' : '{"env":{"TOKEN":"target-canary"}}', { mode: 0o600 });
    const remote = new MemoryRemote(), key = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const a = harnessConfig(first, join(base, "unused-a")), b = harnessConfig(second, join(base, "unused-b"));
    for (const local of [a, b]) { local.mappings[0]!.kind = kind; local.mappings[0]!.namespace = `harness:${kind}:default`; }
    const namespace = a.mappings[0]!.namespace;
    expect((await engine.push(a)).files).toBe(2);
    const inspection = join(base, "decrypted-inspection"); await mkdir(inspection, { mode: 0o700 });
    const observer = structuredClone(a); observer.applied = {}; observer.mappings[0]!.kind = "drop"; observer.mappings[0]!.path = inspection;
    await engine.pull(observer);
    expect(JSON.parse(await readFile(join(inspection, "portable-config/v1/user/model.json"), "utf8"))).toEqual({ value: "fixture", version: 1 });
    await expect(readFile(join(inspection, filename))).rejects.toMatchObject({ code: "ENOENT" });
    const untouched = await readFile(join(second, filename));
    const beforeConfig = structuredClone(b);
    await engine.pull(b, true);
    expect(await readFile(join(second, filename))).toEqual(untouched);
    expect(b).toEqual(beforeConfig);
    await engine.pull(b);
    let restored = await readFile(join(second, filename), "utf8");
    expect(restored).toContain("target-canary"); expect(restored).not.toContain("source-canary");
    expect(restored).toContain("fixture");
    expect(Object.keys(b.applied[namespace]!.digests)).toHaveLength(2);
    expect((await engine.push(b)).outcome).toBe("unchanged");

    // Local-only credential rotation must neither publish nor conflict.
    await writeFile(join(second, filename), restored.replace("target-canary", "rotated-canary"));
    expect((await engine.push(b)).outcome).toBe("unchanged");
    await writeFile(join(first, filename), document("new-model", false, "source-canary"));
    await writeFile(join(second, filename), document("fixture", true, "rotated-canary"));
    await engine.push(a); await engine.push(b); await engine.pull(a); await engine.pull(b);
    restored = await readFile(join(second, filename), "utf8");
    expect(restored).toContain("new-model"); expect(restored).toContain("true"); expect(restored).toContain("rotated-canary");
    expect((await engine.push(a)).outcome).toBe("unchanged");
    expect((await engine.push(b)).outcome).toBe("unchanged");

    await writeFile(join(first, filename), document(undefined, true, "source-canary"));
    await engine.push(a); await engine.pull(b);
    restored = await readFile(join(second, filename), "utf8");
    expect(restored).not.toContain("new-model"); expect(restored).toContain("rotated-canary"); expect(restored).toContain("true");
    expect(Object.keys(b.applied[namespace]!.digests)).toHaveLength(1);
    await writeFile(join(first, filename), kind === "codex" ? 'secret="source-canary"\n' : '{"env":{"TOKEN":"source-canary"}}');
    await engine.push(a); await engine.pull(b);
    expect(await readFile(join(second, filename), "utf8")).toContain("rotated-canary");
    expect(b.applied[namespace]!.digests).toEqual({});
    expect((await engine.push(b)).outcome).toBe("unchanged");
    expect(remote.plaintext).not.toMatch(/canary|new-model/u);
  });

  it.each(["edit", "delete"])("preserves a local setting %s against a divergent remote change (AD-CFG-008)", async (mutation) => {
    const base = await mkdtemp(join(tmpdir(), "statecase-settings-conflict-")); temporary.push(base);
    const first = join(base, "a"), second = join(base, "b");
    await Promise.all([mkdir(first, { mode: 0o700 }), mkdir(second, { mode: 0o700 })]);
    await writeFile(join(first, "config.toml"), 'model="base"', { mode: 0o600 });
    const remote = new MemoryRemote(), key = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const a = harnessConfig(first, join(base, "unused")), b = harnessConfig(second, join(base, "unused"));
    await engine.push(a); await engine.pull(b);
    await writeFile(join(first, "config.toml"), 'model="remote"'); await engine.push(a);
    const local = mutation === "edit" ? 'model="local"\nsecret="preserved"' : 'secret="preserved"';
    await writeFile(join(second, "config.toml"), local);
    const before = structuredClone(b.applied);
    await expect(engine.pull(b)).rejects.toBeInstanceOf(SyncConflict);
    expect(await readFile(join(second, "config.toml"), "utf8")).toBe(local);
    expect(b.applied).toEqual(before);
  });

  it("rolls back all files if an harness rotates a local-only setting during pull (AD-CFG-009)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-settings-cas-")); temporary.push(base);
    const first = join(base, "a"), second = join(base, "b");
    await Promise.all([mkdir(first, { mode: 0o700 }), mkdir(second, { mode: 0o700 })]);
    await mkdir(join(first, "skills", "fixture"), { recursive: true });
    const skillPath = "skills/fixture/SKILL.md";
    await writeFile(join(first, "config.toml"), 'model="base"', { mode: 0o600 });
    await writeFile(join(first, skillPath), "base skill");
    const remote = new MemoryRemote(), key = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const a = harnessConfig(first, join(base, "unused")), b = harnessConfig(second, join(base, "unused"));
    await engine.push(a); await engine.pull(b);
    await writeFile(join(first, "config.toml"), 'model="remote"');
    await writeFile(join(first, skillPath), "new skill"); await engine.push(a);
    const before = structuredClone(b.applied), apply = materialization.applyFileTransaction;
    const spy = vi.spyOn(materialization, "applyFileTransaction").mockImplementationOnce(async (transaction) => apply({ ...transaction,
      beforeCommit: async (index, path) => {
        if (path === join(second, "config.toml")) await writeFile(path, 'model="base"\nsecret="rotated-canary"');
        await transaction.beforeCommit?.(index, path);
      },
    }));
    await expect(engine.pull(b)).rejects.toMatchObject({ code: "CONFIG_FILE_CHANGED" });
    spy.mockRestore();
    expect(await readFile(join(second, skillPath), "utf8")).toBe("base skill");
    expect(await readFile(join(second, "config.toml"), "utf8")).toBe('model="base"\nsecret="rotated-canary"');
    expect(b.applied).toEqual(before);
    await engine.pull(b);
    expect(await readFile(join(second, "config.toml"), "utf8")).toBe('model="remote"\nsecret="rotated-canary"');
  });

  it.each([
    ["config.toml", 'model="injected"'],
    ["portable-config/v2/user/model.json", '{"value":"fixture","version":1}'],
    ["portable-config/v1/user/env.TOKEN.json", '{"value":"canary","version":1}'],
    ["portable-config/v1/user/model.json", '{"value":"fixture","version":1,"secret":"canary"}'],
    ["portable-config/v1/user/model.json", '{"value":42,"version":1}'],
    ["portable-config/v1/user/model.json", " ".repeat(128 * 1024 + 1)],
  ])("rejects sender-controlled config paths/payloads before any apply: %s (AD-CFG-010)", async (path, payload) => {
    const base = await mkdtemp(join(tmpdir(), "statecase-settings-hostile-")); temporary.push(base);
    const source = join(base, "source"), target = join(base, "target");
    await Promise.all([mkdir(source, { mode: 0o700 }), mkdir(target, { mode: 0o700 })]);
    await mkdir(join(source, path, ".."), { recursive: true }); await writeFile(join(source, path), payload);
    await writeFile(join(target, "config.toml"), 'secret="target-canary"', { mode: 0o600 });
    const remote = new MemoryRemote(), key = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const sender = harnessConfig(source, join(base, "unused")), receiver = harnessConfig(target, join(base, "unused"));
    sender.mappings[0]!.kind = "drop";
    await engine.push(sender);
    await expect(engine.pull(receiver)).rejects.toThrow();
    expect(await readFile(join(target, "config.toml"), "utf8")).toBe('secret="target-canary"');
    expect(receiver.applied).toEqual({});
  });

  it.each([1, 2])("restores historical portable preferences at key epoch %i while preserving current secrets and rolling back failed commits (AD-CFG-011)", async (epoch) => {
    const base = await mkdtemp(join(tmpdir(), "statecase-settings-restore-")); temporary.push(base);
    const root = join(base, "codex"); await mkdir(root, { mode: 0o700 });
    const path = join(root, "config.toml");
    await writeFile(path, 'model="old"\nsecret="original-canary"\n[tui]\nanimations=false\n', { mode: 0o600 });
    const remote = new MemoryRemote(), key = await randomKey();
    const client = new StatecaseClient("https://remote.test", "token", remote.fetch);
    let engine = new SyncEngine(client, "vlt_test", key);
    const local = harnessConfig(root, join(base, "unused"));
    const historical = await engine.push(local);
    engine = new SyncEngine(client, "vlt_test", { currentEpoch: epoch, keys: { 1: key, [epoch]: epoch === 1 ? key : await randomKey() } });
    const current = 'model="new"\npersonality="friendly"\nsecret="rotated-canary"\n[tui]\nanimations=true\n';
    await writeFile(path, current); await engine.push(local);
    const before = structuredClone(local.applied), head = remote.scopedRevisionId;
    await engine.restoreInPlace(local, local.mappings[0]!, historical.revisionId!, { dryRun: true });
    expect(await readFile(path, "utf8")).toBe(current); expect(local.applied).toEqual(before);
    const prepareRecovery = async (paths: readonly string[]) => {
      expect(paths).toEqual([path]);
      const snapshot = await createEmergencySnapshot({ id: `restore_${crypto.randomUUID().replaceAll("-", "")}`, createdAt: new Date().toISOString(), statecaseHome: join(base, "statecase"), targetRoot: root, paths });
      return { rollback: () => restoreEmergencySnapshot(snapshot.path) };
    };
    remote.failNextNamespaceCommit = true;
    await expect(engine.restoreInPlace(local, local.mappings[0]!, historical.revisionId!, { prepareRecovery })).rejects.toMatchObject({ status: 409 });
    expect(await readFile(path, "utf8")).toBe(current); expect(local.applied).toEqual(before); expect(remote.scopedRevisionId).toBe(head);
    await engine.restoreInPlace(local, local.mappings[0]!, historical.revisionId!, { prepareRecovery });
    const restored = await readFile(path, "utf8");
    expect(restored).toContain('model="old"'); expect(restored).toContain("animations=false");
    expect(restored).toContain("rotated-canary"); expect(restored).not.toMatch(/personality|original-canary/u);
    expect((await engine.push(local)).outcome).toBe("unchanged");
  });

  it("publishes complete harness JSONL records and defers a live partial tail", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-live-session-"));
    temporary.push(base);
    const source = join(base, "codex-a");
    const target = join(base, "codex-b");
    const sourceWorkspace = join(base, "home-a", "project");
    const targetWorkspace = join(base, "srv", "project");
    await mkdir(join(source, "sessions", "2026"), { recursive: true });
    await Promise.all([mkdir(sourceWorkspace, { recursive: true }), mkdir(targetWorkspace, { recursive: true })]);
    await writeFile(
      join(source, "sessions", "2026", "session.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { cwd: sourceWorkspace, file: join(sourceWorkspace, "readme.md") } })}\n{"message":"still-writing"`,
    );
    await writeFile(
      join(source, "sessions", "2026", "legacy.jsonl"),
      `${JSON.stringify({ type: "legacy_record", payload: { file: join(sourceWorkspace, "legacy.md") } })}\n`,
    );
    const remote = new MemoryRemote();
    const key = await randomKey();
    const sourceConfig = harnessConfig(source, sourceWorkspace);
    const targetConfig = harnessConfig(target, targetWorkspace);
    await new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key).push(sourceConfig);
    await new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key).pull(targetConfig);
    const restored = await readFile(join(target, "sessions", "statecase", "ws_test", "session.jsonl"), "utf8");
    expect(JSON.parse(restored)).toEqual({
      type: "session_meta",
      payload: { cwd: targetWorkspace, file: join(targetWorkspace, "readme.md") },
    });
    expect(JSON.parse(await readFile(join(target, "sessions", "statecase", "ws_test", "legacy.jsonl"), "utf8"))).toEqual({
      type: "legacy_record",
      payload: { file: join(targetWorkspace, "legacy.md") },
    });
  });

  it("streams harness JSONL without an identifiable workspace using its native logical path", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-unbound-session-"));
    temporary.push(base);
    const source = join(base, "source");
    const target = join(base, "target");
    const sessionPath = join(source, "sessions", "2026", "unbound.jsonl");
    await Promise.all([mkdir(join(source, "sessions", "2026"), { recursive: true }), mkdir(target)]);
    await writeFile(sessionPath, `${JSON.stringify({ type: "event", payload: "no paths here" })}\n`);
    const remote = new MemoryRemote();
    const key = await randomKey();
    const sourceConfig = harnessConfig(source, join(base, "unused-source-workspace"));
    const targetConfig = harnessConfig(target, join(base, "unused-target-workspace"));

    await new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key).push(sourceConfig);
    await new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key).pull(targetConfig);

    expect(await readFile(join(target, "sessions", "2026", "unbound.jsonl"), "utf8"))
      .toBe(`${JSON.stringify({ type: "event", payload: "no paths here" })}\n`);
  });

  it("does not upload content-addressed session chunks already present remotely (PERF-003)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-session-tail-"));
    temporary.push(base);
    const harness = join(base, "codex");
    const workspace = join(base, "project");
    const restoredHarness = join(base, "restored-codex");
    const restoredWorkspace = join(base, "restored-project");
    const sessionPath = join(harness, "sessions", "2026", "large.jsonl");
    await Promise.all([
      mkdir(join(harness, "sessions", "2026"), { recursive: true }),
      mkdir(workspace, { recursive: true }),
      mkdir(restoredHarness, { recursive: true }),
      mkdir(restoredWorkspace, { recursive: true }),
    ]);
    const metadata = `${JSON.stringify({ type: "session_meta", payload: { cwd: workspace } })}\n`;
    const record = `${JSON.stringify({ type: "event", payload: "x".repeat(64 * 1024) })}\n`;
    await writeFile(sessionPath, metadata + record.repeat(80));
    const remote = new MemoryRemote();
    const key = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const local = harnessConfig(harness, workspace);

    await engine.push(local);
    const objectsBeforeAppend = new Set(remote.namespaceObjects.keys());
    remote.namespaceObjectWrites.length = 0;
    await writeFile(sessionPath, metadata + record.repeat(80) + `${JSON.stringify({ type: "event", payload: "tail" })}\n`);
    expect(await engine.push(local, true)).toMatchObject({ outcome: "pushed", objects: 2 });
    expect(remote.namespaceObjectWrites).toEqual([]);
    await engine.push(local);

    expect(remote.namespaceObjectWrites.length).toBeGreaterThan(0);
    expect(remote.namespaceObjectWrites.filter((key) => objectsBeforeAppend.has(key))).toEqual([]);
    const restored = harnessConfig(restoredHarness, restoredWorkspace);
    await new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key).pull(restored);
    const restoredText = await readFile(join(restoredHarness, "sessions", "statecase", "ws_test", "large.jsonl"), "utf8");
    expect(restoredText.endsWith(`${JSON.stringify({ type: "event", payload: "tail" })}\n`)).toBe(true);
    expect(restoredText).not.toContain(workspace);

    const namespace = "harness:codex:default";
    const head = remote.namespaceHeads.get(namespace)!;
    const keys = await deriveScopeKey(key, namespace);
    const manifestEnvelope = remote.namespaceObjects.get(`${namespace}\0${head.manifestObjectId}`)!;
    const manifest = namespaceManifestSchema.parse(JSON.parse(new TextDecoder().decode(await decryptEnvelope({
      envelope: manifestEnvelope,
      key: keys.encryptionKey,
      dedupKey: keys.dedupKey,
      expected: { vaultId: "vlt_test", scopeId: namespace, compression: "none" },
    }))));
    const dataObjectKey = `${namespace}\0${manifest.entries[0]!.objectIds[0]!}`;
    const originalObject = remote.namespaceObjects.get(dataObjectKey)!;
    const corruptedObject = originalObject.slice();
    corruptedObject[corruptedObject.length - 1] ^= 1;
    remote.namespaceObjects.set(dataObjectKey, corruptedObject);
    await expect(new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key)
      .pull(harnessConfig(join(base, "corrupt-target"), restoredWorkspace))).rejects.toThrow("authentication failed");
    remote.namespaceObjects.set(dataObjectKey, originalObject);
  }, 30_000);

  it("fails closed on streamed-session bounds and integrity while preserving append-safe local state", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-stream-guards-"));
    temporary.push(base);
    const rootKey = await randomKey();
    const namespace = "harness:codex:default";
    const workspace = join(base, "workspace");
    await mkdir(workspace);
    const local = (name: string, workspaceId = "ws_test") => harnessConfig(join(base, name), workspaceId === "ws_test" ? workspace : join(base, workspaceId));
    const engineFor = (remote: MemoryRemote) => new SyncEngine(
      new StatecaseClient("https://remote.test", "token", remote.fetch),
      "vlt_test",
      rootKey,
    );

    const oversized = new MemoryRemote();
    await publishStreamFixture(oversized, rootKey, {
      namespace,
      logicalPath: "portable-sessions/ws_test/oversized.jsonl",
      bytes: new Uint8Array(),
      totalSize: 20 * 1024 * 1024 * 1024 + 1,
    });
    await expect(engineFor(oversized).pull(local("oversized"))).rejects.toThrow("safety limit");

    const wrongSize = new MemoryRemote();
    const portableBytes = new TextEncoder().encode(`${JSON.stringify({ type: "session_meta", payload: { cwd: "statecase://workspace/ws_test" } })}\n`);
    await publishStreamFixture(wrongSize, rootKey, {
      namespace,
      logicalPath: "portable-sessions/ws_test/wrong-size.jsonl",
      bytes: portableBytes,
      totalSize: portableBytes.byteLength - 1,
    });
    await expect(engineFor(wrongSize).pull(local("wrong-size"))).rejects.toThrow("declared size");

    const wrongDigest = new MemoryRemote();
    await publishStreamFixture(wrongDigest, rootKey, {
      namespace,
      logicalPath: "portable-sessions/ws_test/wrong-digest.jsonl",
      bytes: portableBytes,
      contentDigest: "obj_intentionally_wrong",
    });
    await expect(engineFor(wrongDigest).pull(local("wrong-digest"))).rejects.toThrow("content verification");

    const missingWorkspace = new MemoryRemote();
    await publishStreamFixture(missingWorkspace, rootKey, {
      namespace,
      logicalPath: "portable-sessions/ws_missing/unmapped.jsonl",
      bytes: portableBytes,
    });
    const missingWorkspaceConfig = local("unmapped");
    expect(await engineFor(missingWorkspace).pull(missingWorkspaceConfig)).toMatchObject({ outcome: "pulled", files: 0 });
    expect(missingWorkspaceConfig.applied[namespace]).toBeUndefined();

    const missingWorkspaceTombstone = new MemoryRemote();
    const tombstonePath = "portable-sessions/ws_missing/deleted.jsonl";
    const tombstoneManifest = namespaceManifest("nrev_missing_workspace_tombstone", "snapshot", []);
    tombstoneManifest.namespace = namespace;
    tombstoneManifest.tombstones.push({ namespace, logicalPath: tombstonePath, deletedAt: "2026-09-07T10:00:00.000Z" });
    const tombstoneKeys = await deriveScopeKey(rootKey, namespace);
    tombstoneManifest.pathClaims.push({ pathId: await testPathId(tombstoneKeys.dedupKey, tombstonePath), mutation: "delete" });
    const tombstoneObject = await storeNamespaceManifest(missingWorkspaceTombstone, rootKey, tombstoneManifest);
    missingWorkspaceTombstone.namespaceHeads.set(namespace, {
      namespace,
      revisionId: tombstoneManifest.namespaceRevisionId,
      manifestObjectId: tombstoneObject,
    });
    missingWorkspaceTombstone.scopedRevisionId = "srev_missing_workspace_tombstone";
    const missingWorkspaceTombstoneConfig = local("unmapped-tombstone");
    expect(await engineFor(missingWorkspaceTombstone).pull(missingWorkspaceTombstoneConfig))
      .toMatchObject({ outcome: "pulled", files: 0 });
    expect(missingWorkspaceTombstoneConfig.applied[namespace]).toBeUndefined();

    const normal = new MemoryRemote();
    await publishStreamFixture(normal, rootKey, {
      namespace,
      logicalPath: "portable-sessions/ws_test/session.jsonl",
      bytes: portableBytes,
    });
    const conflictConfig = local("conflict");
    const conflictPath = join(conflictConfig.mappings[0]!.path, "sessions", "statecase", "ws_test", "session.jsonl");
    await mkdir(join(conflictConfig.mappings[0]!.path, "sessions", "statecase", "ws_test"), { recursive: true });
    await writeFile(conflictPath, `${JSON.stringify({ type: "locally_rewritten" })}\n`);
    await expect(engineFor(normal).pull(conflictConfig)).rejects.toBeInstanceOf(SyncConflict);

    const appendSafeConfig = local("append-safe");
    const appendSafePath = join(appendSafeConfig.mappings[0]!.path, "sessions", "statecase", "ws_test", "session.jsonl");
    await mkdir(join(appendSafeConfig.mappings[0]!.path, "sessions", "statecase", "ws_test"), { recursive: true });
    await writeFile(appendSafePath, "");
    await expect(engineFor(normal).pull(appendSafeConfig)).resolves.toMatchObject({ outcome: "pulled", files: 1 });
  });

  it("rejects malformed streamed and workspace payload metadata before filesystem mutation", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-materialize-guards-"));
    temporary.push(base);
    const rootKey = await randomKey();
    const engineFor = (remote: MemoryRemote) => new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", rootKey);
    const bytes = new TextEncoder().encode("verified bytes");

    const short = new MemoryRemote();
    await publishStreamFixture(short, rootKey, {
      namespace: "drop:drop_shared",
      logicalPath: "short.txt",
      bytes,
      totalSize: bytes.byteLength - 1,
    });
    await expect(engineFor(short).pull(config(join(base, "short")))).rejects.toThrow("declared size");

    const badDigest = new MemoryRemote();
    await publishStreamFixture(badDigest, rootKey, {
      namespace: "drop:drop_shared",
      logicalPath: "digest.txt",
      bytes,
      contentDigest: "obj_wrong_digest",
    });
    await expect(engineFor(badDigest).pull(config(join(base, "digest")))).rejects.toThrow("content verification");

    const excludedTombstone = new MemoryRemote();
    const excludedManifest = namespaceManifest("nrev_excluded_tombstone", "snapshot", []);
    excludedManifest.tombstones.push({
      namespace: excludedManifest.namespace,
      logicalPath: ".env",
      deletedAt: "2026-09-07T10:00:00.000Z",
    });
    const excludedKeys = await deriveScopeKey(rootKey, excludedManifest.namespace);
    excludedManifest.pathClaims.push({ pathId: await testPathId(excludedKeys.dedupKey, ".env"), mutation: "delete" });
    const excludedObject = await storeNamespaceManifest(excludedTombstone, rootKey, excludedManifest);
    excludedTombstone.namespaceHeads.set(excludedManifest.namespace, {
      namespace: excludedManifest.namespace,
      revisionId: excludedManifest.namespaceRevisionId,
      manifestObjectId: excludedObject,
    });
    excludedTombstone.scopedRevisionId = "srev_excluded_tombstone";
    const excludedTarget = join(base, "excluded-tombstone");
    await mkdir(excludedTarget);
    await writeFile(join(excludedTarget, ".env"), "SECRET=preserved\n");
    await expect(engineFor(excludedTombstone).pull(config(excludedTarget))).rejects.toThrow("adapter policy");
    expect(await readFile(join(excludedTarget, ".env"), "utf8")).toBe("SECRET=preserved\n");

    const portableDrop = new MemoryRemote();
    await publishStreamFixture(portableDrop, rootKey, {
      namespace: "drop:drop_shared",
      logicalPath: "portable-sessions/ws_test/not-a-harness.jsonl",
      bytes,
    });
    const dropTarget = join(base, "portable-drop");
    await engineFor(portableDrop).pull(config(dropTarget));
    expect(await readFile(join(dropTarget, "portable-sessions", "ws_test", "not-a-harness.jsonl"))).toEqual(Buffer.from(bytes));

    const workspaceCases = [
      { workspaceLayer: "worktree" as const, fileMode: 0o100644 },
      { workspacePath: "file.txt", fileMode: 0o100644 },
      { workspacePath: "file.txt", workspaceLayer: "worktree" as const },
    ];
    for (const [index, metadata] of workspaceCases.entries()) {
      const remote = new MemoryRemote();
      await publishStreamFixture(remote, rootKey, {
        namespace: "workspace:ws_test",
        logicalPath: `$statecase/workspace/blob/worktree/${"a".repeat(40)}/ZmlsZS50eHQ`,
        bytes,
        entryType: "workspace-blob",
        ...metadata,
      });
      await expect(engineFor(remote).pull(workspaceConfig(join(base, `workspace-${index}`))))
        .rejects.toThrow("metadata is incomplete");
    }

    const missingCapsule = new MemoryRemote();
    await publishStreamFixture(missingCapsule, rootKey, {
      namespace: "workspace:ws_test",
      logicalPath: `$statecase/workspace/blob/worktree/${"a".repeat(40)}/ZmlsZS50eHQ`,
      bytes,
      entryType: "workspace-blob",
      workspacePath: "file.txt",
      workspaceLayer: "worktree",
      fileMode: 0o100644,
    });
    await expect(engineFor(missingCapsule).pull(workspaceConfig(join(base, "missing-capsule"))))
      .rejects.toThrow("capsule metadata is missing");
  });

  it("receives a peer's workspace continuation when local dirty bytes still equal the applied capsule (WS-034)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-workspace-return-"));
    temporary.push(base);
    const source = join(base, "source");
    const target = join(base, "target");
    await initializeRepository(source);
    await runFile("git", ["clone", "-q", source, target]);
    const a: LocalConfig = { ...config(source), mappings: [], workspaces: [{ id: "ws_return", path: source, sync: "git" }] };
    const b: LocalConfig = { ...config(target), mappings: [], workspaces: [{ id: "ws_return", path: target, sync: "git" }] };
    const remote = new MemoryRemote();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", await randomKey());
    await writeFile(join(source, "tracked.txt"), "first staged version\n");
    await runFile("git", ["-C", source, "add", "tracked.txt"]);
    await writeFile(join(source, "tracked.txt"), "first worktree version\n");
    await writeFile(join(source, "untracked.txt"), "original untracked\n");
    await engine.push(a);
    await engine.pull(b);
    await writeFile(join(target, "tracked.txt"), "continued on target\n");
    await engine.push(b);
    const before = await readFile(join(source, "tracked.txt"), "utf8");
    expect(before).toBe("first worktree version\n");
    const configBefore = structuredClone(a);
    await expect(engine.pull(a, true)).resolves.toMatchObject({ outcome: "pulled" });
    expect(a).toEqual(configBefore);
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe(before);
    const rawIndex = await readFile(join(source, ".git", "index"));
    const realMaterialize = materialization.applyFileTransaction;
    const failingMaterialize = vi.spyOn(materialization, "applyFileTransaction").mockImplementationOnce(async (transaction) => {
      await realMaterialize({ ...transaction, beforeCommit: async (index, path) => {
        await transaction.beforeCommit?.(index, path);
        if (index === 1) throw new Error("managed workspace mid-commit fault");
      } });
    });
    await expect(engine.pull(a)).rejects.toThrow("managed workspace mid-commit fault");
    failingMaterialize.mockRestore();
    expect(a).toEqual(configBefore);
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe(before);
    expect(await readFile(join(source, ".git", "index"))).toEqual(rawIndex);
    await expect(engine.pull(a)).resolves.toMatchObject({ outcome: "pulled" });
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("continued on target\n");
    expect((await runFile("git", ["-C", source, "show", ":tracked.txt"])).stdout).toBe("first staged version\n");
    expect(await readFile(join(source, "untracked.txt"), "utf8")).toBe("original untracked\n");
  });

  it.each(["worktree", "index", "untracked", "missing-history", "corrupt-history", "substituted-history", "no-applied-marker"])(
    "preserves unsynchronized work and applied state on managed return refusal: %s (WS-034)", async (failure) => {
      const base = await mkdtemp(join(tmpdir(), "statecase-managed-refusal-"));
      temporary.push(base);
      const source = join(base, "source"), target = join(base, "target");
      await initializeRepository(source);
      await runFile("git", ["clone", "-q", source, target]);
      const a: LocalConfig = { ...config(source), mappings: [], workspaces: [{ id: "ws_return", path: source, sync: "git" }] };
      const b: LocalConfig = { ...config(target), mappings: [], workspaces: [{ id: "ws_return", path: target, sync: "git" }] };
      const remote = new MemoryRemote();
      const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", await randomKey());
      await writeFile(join(source, "tracked.txt"), "last applied\n");
      await engine.push(a);
      await engine.pull(b);
      await writeFile(join(target, "tracked.txt"), "continued on peer\n");
      await engine.push(b);
      if (failure === "worktree") await writeFile(join(source, "tracked.txt"), "new unsynced work\n");
      if (failure === "index") await runFile("git", ["-C", source, "add", "tracked.txt"]);
      if (failure === "untracked") await writeFile(join(source, "private.txt"), "new unsynced file\n");
      const prior = remote.namespaceRevisions.get(`workspace:ws_return\0${a.applied["workspace:ws_return"]!.revisionId}`)!;
      if (failure === "substituted-history") {
        // A valid encrypted revision with identical bytes is still not the
        // exact revision requested as the device's last-applied authority.
        await writeFile(join(target, "tracked.txt"), "last applied\n");
        await engine.push(b);
        const substitute = remote.namespaceRevisions.get(`workspace:ws_return\0${b.applied["workspace:ws_return"]!.revisionId}`)!;
        await writeFile(join(target, "tracked.txt"), "continued on peer\n");
        await engine.push(b);
        remote.namespaceRevisions.set(`workspace:ws_return\0${prior.revisionId}`, substitute);
      }
      if (failure === "missing-history") remote.namespaceRevisions.delete(`workspace:ws_return\0${prior.revisionId}`);
      if (failure === "corrupt-history") remote.namespaceObjects.set(`workspace:ws_return\0${prior.manifestObjectId}`, Uint8Array.of(1, 2, 3));
      if (failure === "no-applied-marker") delete a.applied["workspace:ws_return"];
      const before = await readFile(join(source, "tracked.txt"));
      const rawIndex = await readFile(join(source, ".git", "index"));
      const configBefore = structuredClone(a);
      const revision = remote.scopedRevisionId;
      await expect(engine.pull(a)).rejects.toBeInstanceOf(SyncConflict);
      expect(await readFile(join(source, "tracked.txt"))).toEqual(before);
      expect(await readFile(join(source, ".git", "index"))).toEqual(rawIndex);
      expect(a).toEqual(configBefore);
      expect(remote.scopedRevisionId).toBe(revision);
      if (failure === "untracked") expect(await readFile(join(source, "private.txt"), "utf8")).toBe("new unsynced file\n");
    },
  );

  it("pins structured session dependencies to the exact harness, workspace, and Drop revision (WS-019..WS-032)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-session-capsule-"));
    temporary.push(base);
    const harness = join(base, "codex");
    const workspace = join(base, "project");
    const drop = join(base, "reference");
    await initializeRepository(workspace);
    await mkdir(join(harness, "sessions", "2026"), { recursive: true });
    await mkdir(drop);
    await writeFile(join(workspace, ".gitignore"), "ignored.txt\n");
    await runFile("git", ["-C", workspace, "add", ".gitignore"]);
    await runFile("git", ["-C", workspace, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "ignore fixture"]);
    await writeFile(join(workspace, "changed.txt"), "uncommitted context\n");
    await writeFile(join(workspace, "ignored.txt"), "must remain unresolved\n");
    await writeFile(join(drop, "brief.md"), "portable brief\n");
    await writeFile(join(drop, ".env"), "SECRET=must-not-upload\n");
    const session = [
      { type: "session_meta", payload: { cwd: workspace } },
      { type: "tool_call", name: "read_file", arguments: { path: "tracked.txt" } },
      { type: "tool_call", name: "edit_file", arguments: { path: "changed.txt" } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: patch-only.txt\n+native write\n*** End Patch" } },
      { type: "tool_call", name: "read_file", arguments: { path: "ignored.txt" } },
      { type: "tool_call", name: "read_file", arguments: { path: join(drop, "brief.md") } },
      { type: "tool_call", name: "read_file", arguments: { path: join(drop, ".env") } },
      { type: "tool_call", name: "read_file", arguments: { path: "/outside/not-mapped.txt" } },
    ];
    await writeFile(join(workspace, "patch-only.txt"), "native write\n");
    await writeFile(join(harness, "sessions", "2026", "native-01.jsonl"), `${session.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const local: LocalConfig = {
      ...config(drop),
      deviceId: "dev_source",
      mappings: [
        { id: "harness_codex_default", kind: "codex", mode: "two-way", name: "Codex", namespace: "harness:codex:default", path: harness },
        { id: "drop_reference", kind: "drop", mode: "two-way", name: "Reference", namespace: "drop:drop_reference", path: drop },
      ],
      workspaces: [{ id: "ws_project", path: workspace }],
    };
    const remote = new MemoryRemote();
    const key = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const pushed = await engine.push(local);
    const reports = await engine.dependencies();

    expect(remote.namespaceCommitRequests[0]!.updates.find((update) => update.namespace === "harness:codex:default")?.retainedVaultRevisionIds)
      .toEqual([pushed.revisionId]);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      sessionKey: "vlt_test:codex:default:ws_project:native-01",
      harnessRevisionId: pushed.revisionId,
      workspace: { workspaceId: "ws_project", capsuleRevisionId: pushed.revisionId },
      drops: [{ dropId: "drop_reference", revisionId: pushed.revisionId }],
    });
    expect(reports[0]!.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ logicalPath: "tracked.txt", source: "git-baseline", gitObjectId: expect.stringMatching(/^[0-9a-f]{40}$/u), status: "resolved" }),
      expect.objectContaining({ logicalPath: "changed.txt", source: "workspace-overlay", contentDigest: expect.any(String), status: "resolved" }),
      expect.objectContaining({ logicalPath: "patch-only.txt", source: "workspace-overlay", contentDigest: expect.any(String), status: "resolved" }),
      expect.objectContaining({ logicalPath: "ignored.txt", source: "workspace-overlay", status: "unresolved" }),
      expect.objectContaining({ logicalPath: "drop_reference/brief.md", source: "drop", contentDigest: expect.any(String), status: "resolved" }),
      expect.objectContaining({ logicalPath: "drop_reference/.env", source: "drop", status: "unresolved" }),
      expect.objectContaining({ logicalPath: "/outside/not-mapped.txt", source: "external", status: "unresolved" }),
    ]));
    expect(remote.plaintext).not.toContain("not-mapped.txt");
    expect(remote.plaintext).not.toContain("portable brief");

    await expect(engine.hydrate(local, reports[0]!.sessionCapsuleId, { mode: "strict", dryRun: true }))
      .rejects.toMatchObject({
        name: "SessionDependencyError",
        unresolved: ["/outside/not-mapped.txt", "drop_reference/.env", "ignored.txt"],
      });
    await expect(engine.hydrate(local, reports[0]!.sessionCapsuleId, { mode: "best-effort", dryRun: true }))
      .resolves.toMatchObject({
        result: { outcome: "pulled", revisionId: pushed.revisionId },
        warnings: ["/outside/not-mapped.txt", "drop_reference/.env", "ignored.txt"],
      });
    await expect(engine.hydrate({ ...local, mappings: [], workspaces: [] }, reports[0]!.sessionCapsuleId, { mode: "strict", dryRun: true }))
      .rejects.toMatchObject({
        unresolved: expect.arrayContaining(["mapping:harness:codex:default", "mapping:workspace:ws_project", "mapping:drop:drop_reference"]),
      });
    await expect(engine.hydrate(local, "cap_missing", { mode: "strict", dryRun: true })).rejects.toThrow("session capsule not found");

    await writeFile(join(drop, "brief.md"), "newer brief that the old session never saw\n");
    const dropAdvanced = await engine.push(local);
    const retained = (await engine.dependencies())[0]!;
    expect(retained.harnessRevisionId).toBe(pushed.revisionId);

    const targetHarness = join(base, "target-codex");
    const targetWorkspace = join(base, "target-project");
    const targetDrop = join(base, "target-reference");
    await mkdir(targetHarness);
    await mkdir(targetDrop);
    await runFile("git", ["clone", "-q", workspace, targetWorkspace]);
    const targetConfig: LocalConfig = {
      ...local,
      deviceId: "dev_target",
      mappings: local.mappings.map((mapping) => ({
        ...mapping,
        path: mapping.kind === "drop" ? targetDrop : targetHarness,
      })),
      workspaces: [{ id: "ws_project", path: targetWorkspace }],
      applied: {},
      sessionBindings: {},
    };
    const hydrated = await engine.hydrate(targetConfig, retained.sessionCapsuleId, { mode: "warn" });
    expect(hydrated.result.revisionId).toBe(pushed.revisionId);
    expect(hydrated.warnings).toEqual(["/outside/not-mapped.txt", "drop_reference/.env", "ignored.txt"]);
    expect(await readFile(join(targetDrop, "brief.md"), "utf8")).toBe("portable brief\n");
    expect(await readFile(join(targetWorkspace, "changed.txt"), "utf8")).toBe("uncommitted context\n");
    expect(targetConfig.sessionBindings?.[sessionBindingKey("harness:codex:default", "portable-sessions/ws_project/native-01.jsonl")])
      .toBe("sessions/statecase/ws_project/native-01.jsonl");
    const targetDropKeys = await deriveScopeKey(key, "drop:drop_reference");
    expect(targetConfig.applied["drop:drop_reference"]?.digests["brief.md"])
      .toBe(await computeObjectId(targetDropKeys.dedupKey, new TextEncoder().encode("portable brief\n")));

    await writeFile(join(harness, "sessions", "2026", "native-01.jsonl"), `${session.concat([
      { type: "tool_call", name: "read_file", arguments: { path: "changed.txt" } },
    ]).map((record) => JSON.stringify(record)).join("\n")}\n`);
    const scopedPush = await engine.push(local);
    const updated = (await engine.dependencies()).find((report) => report.sessionKey.endsWith(":native-01"))!;
    expect(updated.harnessRevisionId).toBe(scopedPush.revisionId);
    expect(updated.workspace.capsuleRevisionId).toBe(scopedPush.revisionId);
    expect(updated.dependencies.find((dependency) => dependency.logicalPath === "changed.txt")).toMatchObject({ status: "resolved" });

    await rewriteCurrentCapsulePins(remote, key, updated.sessionCapsuleId, {
      workspaceRevisionId: pushed.revisionId!,
      dropRevisionIds: { drop_reference: dropAdvanced.revisionId! },
    });
    const multiRevision = (await engine.dependencies()).find((report) => report.sessionCapsuleId === updated.sessionCapsuleId)!;
    expect(new Set([
      multiRevision.harnessRevisionId,
      multiRevision.workspace.capsuleRevisionId,
      ...multiRevision.drops.map((item) => item.revisionId),
    ]).size).toBe(3);

    const multiTargetHarness = join(base, "multi-target-codex");
    const multiTargetWorkspace = join(base, "multi-target-project");
    const multiTargetDrop = join(base, "multi-target-reference");
    await Promise.all([mkdir(multiTargetHarness), mkdir(multiTargetDrop)]);
    await runFile("git", ["clone", "-q", workspace, multiTargetWorkspace]);
    const multiTargetConfig: LocalConfig = {
      ...targetConfig,
      mappings: targetConfig.mappings.map((mapping) => ({
        ...mapping,
        path: mapping.kind === "drop" ? multiTargetDrop : multiTargetHarness,
      })),
      workspaces: [{ id: "ws_project", path: multiTargetWorkspace }],
      applied: {},
      sessionBindings: {},
    };
    await expect(engine.hydrate(multiTargetConfig, multiRevision.sessionCapsuleId, { mode: "warn", dryRun: true }))
      .resolves.toMatchObject({ result: { outcome: "pulled", revisionId: scopedPush.revisionId } });
    await expect(readFile(join(multiTargetDrop, "brief.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(multiTargetWorkspace, "changed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(multiTargetHarness, "sessions", "statecase", "ws_project", "native-01.jsonl")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const multiHydrated = await engine.hydrate(multiTargetConfig, multiRevision.sessionCapsuleId, { mode: "warn" });
    expect(multiHydrated.result).toMatchObject({ outcome: "pulled", revisionId: scopedPush.revisionId });
    expect(await readFile(join(multiTargetDrop, "brief.md"), "utf8")).toBe("newer brief that the old session never saw\n");
    expect(await readFile(join(multiTargetWorkspace, "changed.txt"), "utf8")).toBe("uncommitted context\n");
    const hydratedSession = await readFile(join(multiTargetHarness, "sessions", "statecase", "ws_project", "native-01.jsonl"), "utf8");
    expect(hydratedSession).toContain(JSON.stringify({ type: "tool_call", name: "read_file", arguments: { path: "changed.txt" } }));
    for (const [namespace, revisionId] of [
      ["harness:codex:default", scopedPush.revisionId],
      ["workspace:ws_project", pushed.revisionId],
      ["drop:drop_reference", dropAdvanced.revisionId],
    ] as const) {
      const scoped = remote.scopedRevisions.get(revisionId!)!;
      expect(multiTargetConfig.applied[namespace]?.revisionId)
        .toBe(scoped.namespaces.find((head) => head.namespace === namespace)?.revisionId);
    }

    const partialHarness = join(base, "partial-target-codex");
    await mkdir(partialHarness);
    const partialConfig: LocalConfig = {
      ...multiTargetConfig,
      mappings: multiTargetConfig.mappings.filter((mapping) => mapping.kind !== "drop")
        .map((mapping) => ({ ...mapping, path: partialHarness })),
      workspaces: [],
      applied: {},
      sessionBindings: {},
    };
    await expect(engine.hydrate(partialConfig, multiRevision.sessionCapsuleId, { mode: "best-effort" }))
      .resolves.toMatchObject({ warnings: expect.arrayContaining(["mapping:workspace:ws_project", "mapping:drop:drop_reference"]) });
    expect(partialConfig.applied["harness:codex:default"]).toBeUndefined();
    await expect(readFile(join(partialHarness, "sessions", "statecase", "ws_project", "native-01.jsonl")))
      .rejects.toMatchObject({ code: "ENOENT" });

    await rewriteCurrentCapsulePins(remote, key, updated.sessionCapsuleId, {
      workspaceRevisionId: pushed.revisionId!,
      dropRevisionIds: { drop_reference: pushed.revisionId! },
    });
    const sharedPinReport = (await engine.dependencies()).find((report) => report.sessionCapsuleId === updated.sessionCapsuleId)!;
    const sharedWorkspace = join(base, "shared-pin-project");
    const sharedDrop = join(base, "shared-pin-reference");
    await mkdir(sharedDrop);
    await runFile("git", ["clone", "-q", workspace, sharedWorkspace]);
    const sharedConfig: LocalConfig = {
      ...multiTargetConfig,
      mappings: multiTargetConfig.mappings.filter((mapping) => mapping.kind === "drop")
        .map((mapping) => ({ ...mapping, path: sharedDrop })),
      workspaces: [{ id: "ws_project", path: sharedWorkspace }],
      applied: {},
      sessionBindings: {},
    };
    await expect(engine.hydrate(sharedConfig, sharedPinReport.sessionCapsuleId, { mode: "best-effort", dryRun: true }))
      .resolves.toMatchObject({ result: { outcome: "pulled" } });
    const sharedPointer = remote.scopedRevisions.get(pushed.revisionId!)!;
    const sharedNamespaces = sharedPointer.namespaces;
    sharedPointer.namespaces = sharedNamespaces.filter((head) => head.namespace !== "drop:drop_reference");
    await expect(engine.hydrate(sharedConfig, sharedPinReport.sessionCapsuleId, { mode: "warn", dryRun: true }))
      .rejects.toThrow("pinned namespace revision is unavailable: drop:drop_reference");
    sharedPointer.namespaces = sharedNamespaces;
    await rewriteCurrentCapsulePins(remote, key, updated.sessionCapsuleId, {
      workspaceRevisionId: pushed.revisionId!,
      dropRevisionIds: { drop_reference: dropAdvanced.revisionId! },
    });

    const dropPointer = remote.scopedRevisions.get(dropAdvanced.revisionId!)!.namespaces
      .find((head) => head.namespace === "drop:drop_reference")!;
    const pinnedDropManifest = await readTestNamespaceManifest(remote, key, dropPointer);
    const missingObjectId = pinnedDropManifest.entries.find((entry) => entry.logicalPath === "brief.md")!.objectIds[0]!;
    remote.namespaceObjects.delete(`drop:drop_reference\0${missingObjectId}`);
    const brokenHarness = join(base, "broken-target-codex");
    const brokenWorkspace = join(base, "broken-target-project");
    const brokenDrop = join(base, "broken-target-reference");
    await Promise.all([mkdir(brokenHarness), mkdir(brokenDrop)]);
    await runFile("git", ["clone", "-q", workspace, brokenWorkspace]);
    const brokenConfig: LocalConfig = {
      ...multiTargetConfig,
      mappings: multiTargetConfig.mappings.map((mapping) => ({
        ...mapping,
        path: mapping.kind === "drop" ? brokenDrop : brokenHarness,
      })),
      workspaces: [{ id: "ws_project", path: brokenWorkspace }],
      applied: {},
      sessionBindings: {},
    };
    await expect(engine.hydrate(brokenConfig, multiRevision.sessionCapsuleId, { mode: "warn" })).rejects.toBeInstanceOf(Error);
    await expect(readFile(join(brokenDrop, "brief.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(brokenWorkspace, "changed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(brokenHarness, "sessions", "statecase", "ws_project", "native-01.jsonl")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("carries modified and untracked Git work over a clean baseline at a different path", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-git-overlay-"));
    temporary.push(base);
    const source = join(base, "home", "project");
    const target = join(base, "srv", "project");
    await initializeRepository(source);
    await mkdir(join(base, "srv"));
    // Independent commits can differ solely by their timestamps. This case
    // requires the same Git baseline, so acquire it through a real clone.
    await runFile("git", ["clone", "-q", source, target]);
    expect((await runFile("git", ["-C", target, "rev-parse", "HEAD"])).stdout)
      .toBe((await runFile("git", ["-C", source, "rev-parse", "HEAD"])).stdout);
    await writeFile(join(source, "tracked.txt"), "work in progress\n");
    await writeFile(join(source, "new.txt"), "untracked dependency\n");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const sourceConfig = workspaceConfig(source);
    const targetConfig = workspaceConfig(target);
    const sourceEngine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const targetEngine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    await sourceEngine.push(sourceConfig);
    await targetEngine.pull(targetConfig);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("work in progress\n");
    expect(await readFile(join(target, "new.txt"), "utf8")).toBe("untracked dependency\n");
  });

  it("recovers a missing baseline through the configured origin during a real pull (WS-015)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-sync-shallow-"));
    temporary.push(base);
    const source = join(base, "source");
    const bare = join(base, "remote.git");
    const target = join(base, "target");
    await initializeRepository(source);
    await runFile("git", ["init", "--bare", "-q", bare]);
    await runFile("git", ["-C", source, "branch", "-M", "main"]);
    await runFile("git", ["-C", source, "remote", "add", "origin", `file://${bare}`]);
    await runFile("git", ["-C", source, "push", "-q", "-u", "origin", "main"]);
    const baseline = (await runFile("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();

    await writeFile(join(source, "tracked.txt"), "portable shallow overlay\n");
    await writeFile(join(source, "untracked.txt"), "portable untracked bytes\n");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const sourceEngine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    await sourceEngine.push(workspaceConfig(source));

    await runFile("git", ["-C", source, "reset", "--hard", "-q", "HEAD"]);
    await writeFile(join(source, "tracked.txt"), "new upstream head\n");
    await runFile("git", ["-C", source, "add", "tracked.txt"]);
    await runFile("git", ["-C", source, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "new upstream head"]);
    await runFile("git", ["-C", source, "push", "-q", "origin", "main"]);
    await runFile("git", ["clone", "-q", "--depth", "1", "--branch", "main", `file://${bare}`, target]);
    await expect(runFile("git", ["-C", target, "cat-file", "-e", `${baseline}^{commit}`])).rejects.toBeInstanceOf(Error);

    const targetConfig = workspaceConfig(target);
    targetConfig.workspaces[0]!.gitFetch = "auto";
    const targetEngine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    await expect(targetEngine.pull(targetConfig)).resolves.toMatchObject({ outcome: "pulled" });
    expect((await runFile("git", ["-C", target, "rev-parse", "HEAD"])).stdout.trim()).toBe(baseline);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("portable shallow overlay\n");
    expect(await readFile(join(target, "untracked.txt"), "utf8")).toBe("portable untracked bytes\n");
  });

  it("restores the exact Git index separately from the working tree (WS-010..WS-016)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-exact-git-"));
    temporary.push(base);
    const source = join(base, "home", "project");
    const target = join(base, "srv", "project");
    await initializeRepository(source);
    await writeFile(join(source, "deleted.txt"), "baseline deletion target\n");
    await runFile("git", ["-C", source, "add", "deleted.txt"]);
    await runFile("git", ["-C", source, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "add deletion target"]);
    await mkdir(join(base, "srv"), { recursive: true });
    await runFile("git", ["clone", "-q", source, target]);

    await writeFile(join(source, "tracked.txt"), "staged bytes\n");
    await runFile("git", ["-C", source, "add", "tracked.txt"]);
    await writeFile(join(source, "tracked.txt"), "worktree bytes\n");
    await runFile("git", ["-C", source, "rm", "-q", "deleted.txt"]);
    await writeFile(join(source, "script.sh"), "#!/bin/sh\nexit 0\n");
    const { chmod } = await import("node:fs/promises");
    await chmod(join(source, "script.sh"), 0o755);

    const remote = new MemoryRemote();
    const key = await randomKey();
    const sourceConfig = workspaceConfig(source);
    const targetConfig = workspaceConfig(target);
    const sourceEngine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const targetEngine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    await sourceEngine.push(sourceConfig);
    await targetEngine.pull(targetConfig);

    expect((await runFile("git", ["-C", target, "show", ":tracked.txt"])).stdout).toBe("staged bytes\n");
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("worktree bytes\n");
    await expect(readFile(join(target, "deleted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await (await import("node:fs/promises")).lstat(join(target, "script.sh"))).mode & 0o111).not.toBe(0);
    expect((await runFile("git", ["-C", target, "status", "--porcelain=v1", "-z"])).stdout)
      .toBe((await runFile("git", ["-C", source, "status", "--porcelain=v1", "-z"])).stdout);

    const unrelated = join(base, "unrelated-drop");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "note.txt"), "other namespace");
    await sourceEngine.push(config(unrelated));
    await expect(targetEngine.pull(targetConfig)).resolves.toMatchObject({ outcome: "unchanged" });
    expect((await runFile("git", ["-C", target, "status", "--porcelain=v1", "-z"])).stdout)
      .toBe((await runFile("git", ["-C", source, "status", "--porcelain=v1", "-z"])).stdout);
  });

  it("does not treat a dirty checkout as a safe Git baseline and fails closed on non-Git workspace scans", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-dirty-git-"));
    temporary.push(base);
    const source = join(base, "source");
    const target = join(base, "target");
    const ordinary = join(base, "ordinary");
    await Promise.all([initializeRepository(source), mkdir(ordinary)]);
    await runFile("git", ["clone", "-q", source, target]);
    await writeFile(join(source, "tracked.txt"), "remote work\n");
    await writeFile(join(target, "tracked.txt"), "local work\n");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const sourceEngine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    await sourceEngine.push(workspaceConfig(source));
    await expect(sourceEngine.pull(workspaceConfig(target))).rejects.toBeInstanceOf(SyncConflict);
    const emptyRemote = new MemoryRemote();
    await expect(new SyncEngine(new StatecaseClient("https://remote.test", "token", emptyRemote.fetch), "vlt_test", key).push(workspaceConfig(ordinary)))
      .rejects.toThrow("not a Git working tree");
  });

  it("handles empty heads, dry runs, and directional mapping policies without remote mutation", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-sync-modes-"));
    temporary.push(base);
    await writeFile(join(base, "file.txt"), "data");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    expect(await engine.pull(config(base))).toMatchObject({ outcome: "unchanged", revisionId: null });
    expect(await engine.dependencies()).toEqual([]);
    const preview = await engine.push(config(base), true);
    expect(preview).toMatchObject({ outcome: "pushed", files: 1 });
    expect(remote.revisionId).toBeNull();

    const consume = config(base);
    consume.mappings[0].mode = "consume";
    expect(await engine.push(consume, true)).toMatchObject({ files: 0 });
    const publish = config(base);
    publish.mappings[0].mode = "publish";
    expect(await engine.pull(publish, true)).toMatchObject({ outcome: "unchanged", files: 0 });
  });

  it("does not create periodic remote revisions when synchronized content is unchanged", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-noop-push-"));
    temporary.push(base);
    await writeFile(join(base, "stable.txt"), "stable");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const local = config(base);
    const first = await engine.push(local);
    const revision = remote.scopedRevisionId;
    expect(first.outcome).toBe("pushed");
    expect(await engine.push(local)).toMatchObject({ outcome: "unchanged", revisionId: revision, objects: 0, bytes: 0 });
    expect(remote.scopedRevisionId).toBe(revision);
  });

  it("fails closed on an invalid key or a mapping that is not a directory", async () => {
    const remote = new MemoryRemote();
    const client = new StatecaseClient("https://remote.test", "token", remote.fetch);
    expect(() => new SyncEngine(client, "vlt_test", new Uint8Array(31))).toThrow("invalid vault key");
    const base = await mkdtemp(join(tmpdir(), "statecase-bad-root-"));
    temporary.push(base);
    const file = join(base, "not-a-directory");
    await writeFile(file, "data");
    const key = await randomKey();
    await expect(new SyncEngine(client, "vlt_test", key).push(config(file))).rejects.toThrow("not a directory");
  });

  it("restores an addressable historical revision without moving the remote head (BK-006)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-historical-"));
    temporary.push(base);
    const source = join(base, "source");
    const staging = join(base, "staging");
    await Promise.all([mkdir(source), mkdir(staging)]);
    await writeFile(join(source, "context.txt"), "version one\n");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const sourceConfig = config(source);
    const first = await engine.push(sourceConfig);
    await writeFile(join(source, "context.txt"), "version two\n");
    const second = await engine.push(sourceConfig);

    await expect(engine.pull(config(staging), true, first.revisionId!)).resolves.toMatchObject({ outcome: "pulled", files: 1 });
    await expect(readFile(join(staging, "context.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await engine.pull(config(staging), false, first.revisionId!);
    expect(await readFile(join(staging, "context.txt"), "utf8")).toBe("version one\n");
    expect(remote.scopedRevisionId).toBe(second.revisionId);
    const scopedStaging = join(base, "scoped-staging");
    await mkdir(scopedStaging);
    await expect(engine.pull(config(scopedStaging), false, second.revisionId!)).resolves.toMatchObject({ outcome: "pulled" });
    expect(await readFile(join(scopedStaging, "context.txt"), "utf8")).toBe("version two\n");
  });

  it.each(["download", "cleanup", "none"])("releases historical rekey buffers after %s and preserves root-key ownership (CR-010)", async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "statecase-rekey-ownership-"));
    temporary.push(root);
    await writeFile(join(root, "context.txt"), "historical\n");
    const remote = new MemoryRemote();
    const client = new StatecaseClient("https://remote.test", "token", remote.fetch);
    const rootKey = await randomKey();
    const local = config(root);
    const historical = await new SyncEngine(client, "vlt_test", rootKey).push(local);
    await writeFile(join(root, "context.txt"), "unpublished local\n");
    const engine = new SyncEngine(client, "vlt_test", { currentEpoch: 2, keys: { 1: rootKey, 2: await randomKey() } });
    const downloadedKeys: Uint8Array[] = [];
    const realDownload = streamTransfer.downloadVerifiedEntry;
    vi.spyOn(streamTransfer, "downloadVerifiedEntry").mockImplementation(async (input) => {
      downloadedKeys.push(input.keys.encryptionKey, input.keys.dedupKey);
      if (failure === "download") throw new Error("injected rekey download failure");
      const staged = await realDownload(input);
      return { ...staged, dispose: async () => {
        await staged.dispose();
        if (failure === "cleanup") throw new Error("injected rekey cleanup failure");
      } };
    });
    const operation = engine.restoreInPlace(local, local.mappings[0]!, historical.revisionId!, {
      prepareRecovery: async () => ({ rollback: async () => { await writeFile(join(root, "context.txt"), "unpublished local\n"); } }),
    });
    if (failure === "none") await expect(operation).resolves.toMatchObject({ outcome: "pulled" });
    else {
      await expect(operation).rejects.toThrow(`injected rekey ${failure} failure`);
      expect(remote.scopedRevisionId).toBe(historical.revisionId);
      expect(await readFile(join(root, "context.txt"), "utf8")).toBe("unpublished local\n");
    }
    expect(downloadedKeys).toHaveLength(2);
    expect(downloadedKeys.every((key) => key.every((byte) => byte === 0))).toBe(true);
    expect(rootKey.some((byte) => byte !== 0)).toBe(true);
  });

  it.each([1, 2])("restores a historical Drop at key epoch %i, rolls back a failed fork, and publishes a new revision (BK-007, BK-009, BK-011, CR-010)", async (epoch) => {
    const base = await mkdtemp(join(tmpdir(), "statecase-in-place-"));
    temporary.push(base);
    const root = join(base, "drop");
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "context.txt"), "version one\n");
    await writeFile(join(root, "resurrect.txt"), "historical\n");
    await writeFile(join(root, "nested", "historical.txt"), "nested historical\n");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const client = new StatecaseClient("https://remote.test", "token", remote.fetch);
    let engine = new SyncEngine(client, "vlt_test", key);
    const local = config(root);
    const historical = await engine.push(local);
    await writeFile(join(root, "post-history.txt"), "created after the selected snapshot\n");
    await engine.push(local);
    await rm(join(root, "post-history.txt"));
    const keys: VaultKeyring = { currentEpoch: epoch, keys: { 1: key } };
    if (epoch === 2) keys.keys[2] = await randomKey();
    engine = new SyncEngine(client, "vlt_test", keys);
    await writeFile(join(root, "context.txt"), "version two\n");
    await rm(join(root, "resurrect.txt"));
    await rm(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "newer.txt"), "newer remote state\n");
    const current = await engine.push(local);
    await writeFile(join(root, "local-only.txt"), "unpublished local state\n");

    const dryRun = await engine.restoreInPlace(local, local.mappings[0]!, historical.revisionId!, { dryRun: true });
    expect(dryRun).toMatchObject({ outcome: "pulled", dryRun: true, historicalRevisionId: historical.revisionId });
    expect(remote.scopedRevisionId).toBe(current.revisionId);
    expect(await readFile(join(root, "context.txt"), "utf8")).toBe("version two\n");

    remote.failNextNamespaceCommit = true;
    const prepareRecovery = async (paths: readonly string[]) => {
      const snapshot = await createEmergencySnapshot({
        id: `restore_${crypto.randomUUID().replaceAll("-", "")}`,
        createdAt: new Date().toISOString(),
        statecaseHome: join(base, "statecase"),
        targetRoot: root,
        paths,
      });
      return { rollback: () => restoreEmergencySnapshot(snapshot.path) };
    };
    await expect(engine.restoreInPlace(local, local.mappings[0]!, historical.revisionId!, { prepareRecovery }))
      .rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(root, "context.txt"), "utf8")).toBe("version two\n");
    await expect(readFile(join(root, "resurrect.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "nested", "historical.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "newer.txt"), "utf8")).toBe("newer remote state\n");
    expect(await readFile(join(root, "local-only.txt"), "utf8")).toBe("unpublished local state\n");

    const restored = await engine.restoreInPlace(local, local.mappings[0]!, historical.revisionId!, { prepareRecovery });
    expect(restored).toMatchObject({ outcome: "pulled", dryRun: false, historicalRevisionId: historical.revisionId });
    expect(restored.revisionId).not.toBe(historical.revisionId);
    expect(restored.revisionId).not.toBe(current.revisionId);
    expect(await readFile(join(root, "context.txt"), "utf8")).toBe("version one\n");
    expect(await readFile(join(root, "resurrect.txt"), "utf8")).toBe("historical\n");
    expect(await readFile(join(root, "nested", "historical.txt"), "utf8")).toBe("nested historical\n");
    await expect(readFile(join(root, "newer.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "local-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const observerRoot = join(base, "observer");
    await mkdir(observerRoot);
    await new SyncEngine(client, "vlt_test", keys).pull(config(observerRoot));
    expect(remote.namespaceHeads.get("drop:drop_shared")?.keyEpoch).toBe(epoch);
    const restoredManifest = await readTestNamespaceManifest(remote, keys.keys[epoch]!, remote.namespaceHeads.get("drop:drop_shared")!);
    expect(restoredManifest.tombstones).toEqual(expect.arrayContaining([expect.objectContaining({ logicalPath: "post-history.txt" })]));
    expect(await readFile(join(observerRoot, "context.txt"), "utf8")).toBe("version one\n");
    expect(await readFile(join(observerRoot, "resurrect.txt"), "utf8")).toBe("historical\n");
    expect(await readFile(join(observerRoot, "nested", "historical.txt"), "utf8")).toBe("nested historical\n");
    await expect(readFile(join(observerRoot, "newer.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([1, 2])("restores a historical Git workspace at epoch %i with exact rollback on a failed fork (BK-009, WS-030, CR-010)", async (epoch) => {
    const base = await mkdtemp(join(tmpdir(), "statecase-workspace-in-place-"));
    temporary.push(base);
    const root = join(base, "workspace");
    await initializeRepository(root);
    await runFile("git", ["-C", root, "branch", "-M", "main"]);
    const historicalCommit = (await runFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(root, "tracked.txt"), "historical index\n");
    await runFile("git", ["-C", root, "add", "tracked.txt"]);
    await writeFile(join(root, "tracked.txt"), "historical worktree\n");
    await writeFile(join(root, "historical-only.txt"), "historical untracked\n");
    const historicalStatus = (await runFile("git", ["-C", root, "status", "--porcelain=v1", "-z"])).stdout;

    const remote = new MemoryRemote();
    const key = await randomKey();
    const client = new StatecaseClient("https://remote.test", "token", remote.fetch);
    let engine = new SyncEngine(client, "vlt_test", key);
    const local = workspaceConfig(root);
    local.workspaces[0]!.gitFetch = "auto";
    const mapping = workspaceMapping(local);
    const historical = await engine.push(local);
    const keyring = { currentEpoch: epoch, keys: { 1: key, [epoch]: epoch === 1 ? key : await randomKey() } };
    engine = new SyncEngine(client, "vlt_test", keyring);

    await runFile("git", ["-C", root, "reset", "--hard", "-q", "HEAD"]);
    await writeFile(join(root, "tracked.txt"), "later committed\n");
    await runFile("git", ["-C", root, "add", "tracked.txt"]);
    await runFile("git", ["-C", root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "later"]);
    await writeFile(join(root, "tracked.txt"), "current index\n");
    await runFile("git", ["-C", root, "add", "tracked.txt"]);
    await writeFile(join(root, "tracked.txt"), "current worktree\n");
    await writeFile(join(root, "current-only.txt"), "current untracked\n");
    const current = await engine.push(local);
    await writeFile(join(root, "local-only.txt"), "not uploaded\n");
    const currentHead = (await runFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const currentStatus = (await runFile("git", ["-C", root, "status", "--porcelain=v1", "-z"])).stdout;
    const currentIndex = await readFile(join(root, ".git", "index"));

    const dryRun = await engine.restoreInPlace(local, mapping, historical.revisionId!, { dryRun: true });
    expect(dryRun).toMatchObject({ dryRun: true, namespace: "workspace:ws_test" });
    expect((await runFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(currentHead);
    expect(remote.scopedRevisionId).toBe(current.revisionId);

    const statecaseHome = join(base, "statecase");
    const prepareRecovery = async (paths: readonly string[], context?: { kind: "workspace"; targetHeadRef: string | null }) => {
      expect(context).toEqual({ kind: "workspace", targetHeadRef: "main" });
      const snapshot = await createEmergencySnapshot({
        id: `restore_${crypto.randomUUID().replaceAll("-", "")}`,
        createdAt: new Date().toISOString(),
        statecaseHome,
        targetRoot: root,
        paths,
        workspace: { targetHeadRef: context!.targetHeadRef },
      });
      return { rollback: () => restoreEmergencySnapshot(snapshot.path) };
    };

    remote.failNextNamespaceCommit = true;
    await expect(engine.restoreInPlace(local, mapping, historical.revisionId!, { prepareRecovery }))
      .rejects.toMatchObject({ status: 409 });
    expect((await runFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(currentHead);
    expect((await runFile("git", ["-C", root, "symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("main");
    expect(await readFile(join(root, ".git", "index"))).toEqual(currentIndex);
    expect((await runFile("git", ["-C", root, "status", "--porcelain=v1", "-z"])).stdout).toBe(currentStatus);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("current worktree\n");
    expect(await readFile(join(root, "local-only.txt"), "utf8")).toBe("not uploaded\n");

    const restored = await engine.restoreInPlace(local, mapping, historical.revisionId!, { prepareRecovery });
    expect(restored.revisionId).not.toBe(historical.revisionId);
    expect(restored.revisionId).not.toBe(current.revisionId);
    expect((await runFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(historicalCommit);
    expect((await runFile("git", ["-C", root, "symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("main");
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("historical worktree\n");
    expect((await runFile("git", ["-C", root, "show", ":tracked.txt"])).stdout).toBe("historical index\n");
    expect(await readFile(join(root, "historical-only.txt"), "utf8")).toBe("historical untracked\n");
    await expect(readFile(join(root, "current-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "local-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await runFile("git", ["-C", root, "status", "--porcelain=v1", "-z"])).stdout).toBe(historicalStatus);

    const observer = join(base, "observer");
    await runFile("git", ["clone", "-q", root, observer]);
    const observerConfig = workspaceConfig(observer);
    await new SyncEngine(client, "vlt_test", keyring).pull(observerConfig);
    expect((await runFile("git", ["-C", observer, "status", "--porcelain=v1", "-z"])).stdout).toBe(historicalStatus);
    expect(await readFile(join(observer, "tracked.txt"), "utf8")).toBe("historical worktree\n");
  });

  it("refuses SQLite-family in-place targets before recovery preparation or mutation (BK-007)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-in-place-db-"));
    temporary.push(base);
    const root = join(base, "drop");
    await mkdir(root);
    await writeFile(join(root, "state.db"), "database fixture");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const local = config(root);
    const historical = await engine.push(local);
    const consume = structuredClone(local);
    consume.mappings[0]!.mode = "consume";
    await expect(engine.restoreInPlace(consume, consume.mappings[0]!, historical.revisionId!, { dryRun: true }))
      .rejects.toThrow("two-way");
    await rm(join(root, "state.db"));
    const current = await engine.push(local);
    let prepared = false;
    await expect(engine.restoreInPlace(local, local.mappings[0]!, historical.revisionId!, {
      prepareRecovery: async () => {
        prepared = true;
        return { rollback: async () => undefined };
      },
    })).rejects.toThrow("SQLite");
    expect(prepared).toBe(false);
    expect(remote.scopedRevisionId).toBe(current.revisionId);
    await expect(readFile(join(root, "state.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an in-place target whose parent path has become a symlink (BK-007)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-in-place-symlink-"));
    temporary.push(base);
    const root = join(base, "drop");
    const outside = join(base, "outside");
    await Promise.all([mkdir(join(root, "nested"), { recursive: true }), mkdir(outside)]);
    await writeFile(join(root, "nested", "context.txt"), "historical\n");
    await writeFile(join(outside, "context.txt"), "outside must survive\n");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const local = config(root);
    const historical = await engine.push(local);
    await rm(join(root, "nested"), { recursive: true });
    await engine.push(local);

    const linkedRoot = join(base, "linked-root");
    await symlink(root, linkedRoot);
    const linkedConfig = config(linkedRoot);
    await expect(engine.restoreInPlace(linkedConfig, linkedConfig.mappings[0]!, historical.revisionId!, { dryRun: true }))
      .rejects.toThrow("real directory");

    await symlink(outside, join(root, "nested"));
    let prepared = false;
    await expect(engine.restoreInPlace(local, local.mappings[0]!, historical.revisionId!, {
      prepareRecovery: async () => {
        prepared = true;
        return { rollback: async () => undefined };
      },
    })).rejects.toThrow("symlinked");
    expect(prepared).toBe(false);
    expect(await readFile(join(outside, "context.txt"), "utf8")).toBe("outside must survive\n");

    await rm(join(root, "nested"));
    await writeFile(join(root, "nested"), "ordinary file blocks the parent path\n");
    await expect(engine.restoreInPlace(local, local.mappings[0]!, historical.revisionId!, {
      prepareRecovery: async () => {
        prepared = true;
        return { rollback: async () => undefined };
      },
    })).rejects.toThrow(/not a directory|ENOTDIR/u);
    expect(prepared).toBe(false);
  });

  it.each([1, 2])("preserves historical Session Capsule pins when restoring a harness at epoch %i (BK-010, WS-024, CR-010)", async (epoch) => {
    const base = await mkdtemp(join(tmpdir(), "statecase-in-place-session-"));
    temporary.push(base);
    const harness = join(base, "codex");
    const workspace = join(base, "workspace");
    const session = join(harness, "sessions", "2026", "09", "07", "restore.jsonl");
    await Promise.all([mkdir(join(harness, "sessions", "2026", "09", "07"), { recursive: true }), mkdir(workspace)]);
    const firstRecord = JSON.stringify({ type: "session_meta", payload: { cwd: workspace } });
    await writeFile(session, `${firstRecord}\n`);
    const remote = new MemoryRemote();
    const key = await randomKey();
    const client = new StatecaseClient("https://remote.test", "token", remote.fetch);
    let engine = new SyncEngine(client, "vlt_test", key);
    const local = harnessConfig(harness, workspace);
    const historical = await engine.push(local);
    const historicalHead = remote.scopedRevisions.get(historical.revisionId!)!.namespaces
      .find((head) => head.namespace === "harness:codex:default")!;
    const historicalManifest = await readTestNamespaceManifest(remote, key, historicalHead);
    const currentKey = epoch === 1 ? key : await randomKey();
    engine = new SyncEngine(client, "vlt_test", { currentEpoch: epoch, keys: { 1: key, [epoch]: currentKey } });
    await writeFile(session, `${firstRecord}\n${JSON.stringify({ type: "response_item", payload: { value: 2 } })}\n`);
    await engine.push(local);

    const statecaseHome = join(base, "statecase");
    const restored = await engine.restoreInPlace(local, local.mappings[0]!, historical.revisionId!, {
      prepareRecovery: async (paths) => {
        const snapshot = await createEmergencySnapshot({
          id: "restore_session_capsule",
          createdAt: "2026-09-07T18:00:00.000Z",
          statecaseHome,
          targetRoot: harness,
          paths,
          harness: "codex",
        });
        return { rollback: () => restoreEmergencySnapshot(snapshot.path) };
      },
    });
    const restoredHead = remote.namespaceHeads.get("harness:codex:default")!;
    const restoredManifest = await readTestNamespaceManifest(remote, currentKey, restoredHead);
    expect(restoredManifest.sessionCapsules).toEqual(historicalManifest.sessionCapsules);
    expect(restoredManifest.sessionCapsules?.[0]?.harnessRevisionId).toBe(historical.revisionId);
    expect(restored.revisionId).not.toBe(historical.revisionId);
    expect(await readFile(session, "utf8")).toBe(`${firstRecord}\n`);
  });

  it("merges disjoint offline edits and pulls the remote side before marking it applied (SY-002, SY-003)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-three-way-"));
    temporary.push(base);
    const firstRoot = join(base, "first");
    const secondRoot = join(base, "second");
    const observerRoot = join(base, "observer");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot), mkdir(observerRoot)]);
    await writeFile(join(firstRoot, "base.txt"), "base\n");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const firstEngine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const secondEngine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const firstConfig = config(firstRoot);
    const secondConfig = config(secondRoot);
    await firstEngine.push(firstConfig);
    await secondEngine.pull(secondConfig);
    const commonRevision = secondConfig.applied["drop:drop_shared"]!.revisionId;

    await writeFile(join(firstRoot, "from-first.txt"), "first\n");
    await writeFile(join(secondRoot, "from-second.txt"), "second\n");
    await firstEngine.push(firstConfig);
    const merged = await secondEngine.push(secondConfig);
    expect(merged.outcome).toBe("pushed");
    expect(secondConfig.applied["drop:drop_shared"]!.revisionId).toBe(commonRevision);
    await secondEngine.pull(secondConfig);
    expect(await readFile(join(secondRoot, "from-first.txt"), "utf8")).toBe("first\n");
    expect(await readFile(join(secondRoot, "from-second.txt"), "utf8")).toBe("second\n");

    await new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key).pull(config(observerRoot));
    expect(await readFile(join(observerRoot, "from-first.txt"), "utf8")).toBe("first\n");
    expect(await readFile(join(observerRoot, "from-second.txt"), "utf8")).toBe("second\n");
  });

  it.each([1, 2].flatMap((epoch) => ["none", "base-download", "remote-download", "cleanup"].map((failure) => ({ epoch, failure }))))("merges concurrent complete-record appends across epoch $epoch after $failure and restores each native path (ID-012, SY-004, SY-005, CR-010)", async ({ epoch, failure }) => {
    const base = await mkdtemp(join(tmpdir(), "statecase-session-append-merge-"));
    temporary.push(base);
    const firstHarness = join(base, "first-codex");
    const secondHarness = join(base, "second-codex");
    const firstWorkspace = join(base, "first-workspace");
    const secondWorkspace = join(base, "second-workspace");
    await Promise.all([
      mkdir(join(firstHarness, "sessions", "2026"), { recursive: true }),
      mkdir(firstWorkspace),
      mkdir(secondWorkspace),
    ]);
    const baseRecord = { type: "session_meta", payload: { cwd: firstWorkspace } };
    const firstAppend = [
      { type: "tool_call", id: "remote-1", name: "read_file", arguments: { path: "remote.md" } },
      { type: "assistant", id: "remote-2", message: "first branch" },
    ];
    const secondAppend = [
      { type: "tool_call", id: "local-1", name: "read_file", arguments: { path: "local.md" } },
      { type: "assistant", id: "local-2", message: "second branch" },
    ];
    const sourceSession = join(firstHarness, "sessions", "2026", "session.jsonl");
    await writeFile(sourceSession, `${JSON.stringify(baseRecord)}\n`);

    const remote = new MemoryRemote();
    const key = await randomKey();
    const client = new StatecaseClient("https://remote.test", "token", remote.fetch);
    let firstEngine = new SyncEngine(client, "vlt_test", key);
    let secondEngine = new SyncEngine(client, "vlt_test", key);
    const firstConfig = harnessConfig(firstHarness, firstWorkspace);
    const secondConfig = harnessConfig(secondHarness, secondWorkspace);
    await firstEngine.push(firstConfig);
    const bindingKey = sessionBindingKey("harness:codex:default", "portable-sessions/ws_test/session.jsonl");
    expect(firstConfig.sessionBindings?.[bindingKey]).toBe("sessions/2026/session.jsonl");
    await secondEngine.pull(secondConfig);
    const commonRevision = secondConfig.applied["harness:codex:default"]!.revisionId;
    const secondSession = join(secondHarness, "sessions", "statecase", "ws_test", "session.jsonl");
    expect(secondConfig.sessionBindings?.[bindingKey]).toBe("sessions/statecase/ws_test/session.jsonl");

    const currentKey = epoch === 1 ? key : await randomKey();
    const keyring = { currentEpoch: epoch, keys: { 1: key, [epoch]: currentKey } };
    firstEngine = new SyncEngine(client, "vlt_test", keyring);
    secondEngine = new SyncEngine(client, "vlt_test", keyring);

    await writeFile(sourceSession, `${[baseRecord, ...firstAppend].map((record) => JSON.stringify(record)).join("\n")}\n`);
    const localizedBase = { type: "session_meta", payload: { cwd: secondWorkspace } };
    await firstEngine.push(firstConfig);
    const remoteHeadBeforeRejectedRewrite = remote.namespaceHeads.get("harness:codex:default")!.revisionId;
    await writeFile(secondSession, `${[{ ...localizedBase, rewritten: true }, ...secondAppend].map((record) => JSON.stringify(record)).join("\n")}\n`);
    await expect(secondEngine.push(secondConfig)).rejects.toMatchObject({
      paths: ["harness:codex:default:portable-sessions/ws_test/session.jsonl"],
    });
    expect(remote.namespaceHeads.get("harness:codex:default")!.revisionId).toBe(remoteHeadBeforeRejectedRewrite);

    await writeFile(secondSession, `${[localizedBase, ...secondAppend].map((record) => JSON.stringify(record)).join("\n")}\n`);
    const downloadedKeys: Uint8Array[] = [];
    const realDownload = streamTransfer.downloadVerifiedEntry;
    let downloadCount = 0;
    const stagedMerges: string[] = [];
    const realMerge = appendMerge.mergeJsonlAppendFiles;
    const mergeSpy = vi.spyOn(appendMerge, "mergeJsonlAppendFiles").mockImplementation(async (input) => {
      const result = await realMerge(input);
      if (result.outcome === "merged") stagedMerges.push(result.path);
      return result;
    });
    const downloadSpy = vi.spyOn(streamTransfer, "downloadVerifiedEntry").mockImplementation(async (input) => {
      downloadedKeys.push(input.keys.encryptionKey, input.keys.dedupKey);
      downloadCount += 1;
      if ((failure === "base-download" && downloadCount === 1) || (failure === "remote-download" && downloadCount === 2)) {
        throw new Error(`injected append ${failure} failure`);
      }
      const staged = await realDownload(input);
      return { ...staged, dispose: async () => {
        await staged.dispose();
        if (failure === "cleanup") throw new Error("injected append cleanup failure");
      } };
    });
    if (failure === "none") await expect(secondEngine.push(secondConfig)).resolves.toMatchObject({ outcome: "pushed" });
    else {
      await expect(secondEngine.push(secondConfig)).rejects.toThrow(`injected append ${failure} failure`);
      expect(remote.namespaceHeads.get("harness:codex:default")!.revisionId).toBe(remoteHeadBeforeRejectedRewrite);
    }
    downloadSpy.mockRestore();
    mergeSpy.mockRestore();
    expect(downloadedKeys.length).toBeGreaterThanOrEqual(failure === "base-download" ? 2 : 4);
    expect(downloadedKeys.every((key) => key.every((byte) => byte === 0))).toBe(true);
    for (const path of stagedMerges) await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    if (failure !== "none") await expect(secondEngine.push(secondConfig)).resolves.toMatchObject({ outcome: "pushed" });
    expect(secondConfig.applied["harness:codex:default"]!.revisionId).toBe(commonRevision);

    const dependencies = (await secondEngine.dependencies()).find((report) => report.sessionKey.endsWith(":session"))!;
    expect(dependencies.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ logicalPath: "remote.md" }),
      expect.objectContaining({ logicalPath: "local.md" }),
    ]));

    await expect(secondEngine.pull(secondConfig)).resolves.toMatchObject({ outcome: "pulled" });
    const mergedRecords = (await readFile(secondSession, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as { id?: string });
    const ids = mergedRecords.flatMap((record) => record.id ? [record.id] : []);
    expect(ids).toHaveLength(4);
    expect(new Set(ids)).toEqual(new Set(["remote-1", "remote-2", "local-1", "local-2"]));
    expect(ids.indexOf("remote-1")).toBeLessThan(ids.indexOf("remote-2"));
    expect(ids.indexOf("local-1")).toBeLessThan(ids.indexOf("local-2"));
    expect(secondConfig.applied["harness:codex:default"]!.revisionId).toBe(remote.namespaceHeads.get("harness:codex:default")!.revisionId);

    await expect(firstEngine.pull(firstConfig)).resolves.toMatchObject({ outcome: "pulled" });
    const originRecords = (await readFile(sourceSession, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as { id?: string });
    const originIds = originRecords.flatMap((record) => record.id ? [record.id] : []);
    expect(originIds).toHaveLength(4);
    expect(new Set(originIds)).toEqual(new Set(["remote-1", "remote-2", "local-1", "local-2"]));
    await expect(readFile(join(firstHarness, "sessions", "statecase", "ws_test", "session.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });

    await rm(sourceSession);
    await expect(firstEngine.push(firstConfig)).resolves.toMatchObject({ outcome: "pushed" });
    expect(firstConfig.sessionBindings?.[bindingKey]).toBeUndefined();
    await expect(secondEngine.pull(secondConfig)).resolves.toMatchObject({ outcome: "pulled" });
    await expect(readFile(secondSession)).rejects.toMatchObject({ code: "ENOENT" });
    expect(secondConfig.sessionBindings?.[bindingKey]).toBeUndefined();
  });

  it("keeps session bindings local, rejects traversal, and detects destination collisions before apply (ID-012)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-session-bindings-"));
    temporary.push(base);
    const sourceHarness = join(base, "source-codex");
    const sourceWorkspaceOne = join(base, "source-workspace-one");
    const sourceWorkspaceTwo = join(base, "source-workspace-two");
    const dryHarness = join(base, "dry-codex");
    const dryWorkspaceOne = join(base, "dry-workspace-one");
    const dryWorkspaceTwo = join(base, "dry-workspace-two");
    const unsafeHarness = join(base, "unsafe-codex");
    const unsafeWorkspaceOne = join(base, "unsafe-workspace-one");
    const unsafeWorkspaceTwo = join(base, "unsafe-workspace-two");
    const collisionHarness = join(base, "collision-codex");
    const collisionWorkspaceOne = join(base, "collision-workspace-one");
    const collisionWorkspaceTwo = join(base, "collision-workspace-two");
    await Promise.all([
      mkdir(join(sourceHarness, "sessions", "2026", "one"), { recursive: true }),
      mkdir(join(sourceHarness, "sessions", "2026", "two"), { recursive: true }),
      mkdir(sourceWorkspaceOne),
      mkdir(sourceWorkspaceTwo),
      mkdir(dryHarness),
      mkdir(dryWorkspaceOne),
      mkdir(dryWorkspaceTwo),
      mkdir(unsafeHarness),
      mkdir(unsafeWorkspaceOne),
      mkdir(unsafeWorkspaceTwo),
      mkdir(collisionHarness),
      mkdir(collisionWorkspaceOne),
      mkdir(collisionWorkspaceTwo),
    ]);
    const record = (cwd: string, id: string) => ({ type: "session_meta", id, payload: { cwd } });
    await Promise.all([
      writeFile(join(sourceHarness, "sessions", "2026", "one", "same.jsonl"), `${JSON.stringify(record(sourceWorkspaceOne, "one"))}\n`),
      writeFile(join(sourceHarness, "sessions", "2026", "two", "same.jsonl"), `${JSON.stringify(record(sourceWorkspaceTwo, "two"))}\n`),
    ]);
    const boundConfig = (harness: string, workspaceOne: string, workspaceTwo: string): LocalConfig => {
      const value = harnessConfig(harness, workspaceOne);
      value.workspaces = [
        { id: "ws_one", path: workspaceOne, sync: "identity-only" },
        { id: "ws_two", path: workspaceTwo, sync: "identity-only" },
      ];
      return value;
    };
    const remote = new MemoryRemote();
    const key = await randomKey();
    const sourceEngine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    await sourceEngine.push(boundConfig(sourceHarness, sourceWorkspaceOne, sourceWorkspaceTwo));

    const dryConfig = boundConfig(dryHarness, dryWorkspaceOne, dryWorkspaceTwo);
    await expect(sourceEngine.pull(dryConfig, true)).resolves.toMatchObject({ outcome: "pulled", files: 2 });
    expect(dryConfig.sessionBindings).toBeUndefined();
    await expect(readFile(join(dryHarness, "sessions", "statecase", "ws_one", "same.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });

    const unsafeConfig = boundConfig(unsafeHarness, unsafeWorkspaceOne, unsafeWorkspaceTwo);
    unsafeConfig.sessionBindings = {
      [sessionBindingKey("harness:codex:default", "portable-sessions/ws_one/same.jsonl")]: "../../escaped.jsonl",
    };
    await expect(sourceEngine.pull(unsafeConfig)).rejects.toThrow("unsafe remote path");
    await expect(readFile(join(base, "escaped.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });

    const collisionConfig = boundConfig(collisionHarness, collisionWorkspaceOne, collisionWorkspaceTwo);
    collisionConfig.sessionBindings = {
      [sessionBindingKey("harness:codex:default", "portable-sessions/ws_one/same.jsonl")]: "sessions/statecase/shared/same.jsonl",
      [sessionBindingKey("harness:codex:default", "portable-sessions/ws_two/same.jsonl")]: "sessions/statecase/shared/same.jsonl",
    };
    await expect(sourceEngine.pull(collisionConfig)).rejects.toThrow("local materialization paths collide");
    await expect(readFile(join(collisionHarness, "sessions", "same.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an explicit conflict when two offline devices modify the same path (SY-006, SY-007)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-three-way-conflict-"));
    temporary.push(base);
    const firstRoot = join(base, "first");
    const secondRoot = join(base, "second");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    await writeFile(join(firstRoot, "shared.txt"), "base\n");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const firstEngine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const secondEngine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const firstConfig = config(firstRoot);
    const secondConfig = config(secondRoot);
    await firstEngine.push(firstConfig);
    await secondEngine.pull(secondConfig);
    await writeFile(join(firstRoot, "shared.txt"), "first\n");
    await writeFile(join(secondRoot, "shared.txt"), "second\n");
    await firstEngine.push(firstConfig);
    await expect(secondEngine.push(secondConfig)).rejects.toMatchObject({ paths: ["drop:drop_shared:shared.txt"] });
    expect(await readFile(join(secondRoot, "shared.txt"), "utf8")).toBe("second\n");
    const conflictedHead = remote.scopedRevisionId!;
    await expect(secondEngine.push(secondConfig, false, {
      resolveLocalNamespaces: new Set(["drop:drop_shared"]),
      expectedHeadRevisionId: "rev_wrong",
    })).rejects.toBeInstanceOf(SyncConflict);
    expect(remote.scopedRevisionId).toBe(conflictedHead);
    await secondEngine.push(secondConfig, false, {
      resolveLocalNamespaces: new Set(["drop:drop_shared"]),
      expectedHeadRevisionId: conflictedHead,
    });
    const observer = join(base, "observer");
    await mkdir(observer);
    await new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key).pull(config(observer));
    expect(await readFile(join(observer, "shared.txt"), "utf8")).toBe("second\n");
  });

  it("never lets an append-only mapping overwrite prior content", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-append-only-"));
    temporary.push(base);
    await writeFile(join(base, "immutable.txt"), "first\n");
    const remote = new MemoryRemote();
    const key = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", key);
    const local = config(base);
    local.mappings[0]!.mode = "append";
    await engine.push(local);
    await writeFile(join(base, "immutable.txt"), "replacement\n");
    await expect(engine.push(local)).rejects.toMatchObject({ paths: ["drop:drop_shared:immutable.txt:append-only"] });
    await rm(join(base, "immutable.txt"));
    await expect(engine.push(local)).rejects.toMatchObject({ paths: ["drop:drop_shared:immutable.txt:append-only"] });
  });

  it("fails closed across scoped expiry, authority, mapping, history, dry-run, and deletion edges", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-scoped-edges-"));
    temporary.push(base);
    const source = join(base, "source");
    const sandbox = join(base, "sandbox");
    await Promise.all([mkdir(source), mkdir(sandbox)]);
    await writeFile(join(source, "existing.txt"), "existing\n");
    const remote = new MemoryRemote();
    const rootKey = await randomKey();
    await new SyncEngine(new StatecaseClient("https://remote.test", "device", remote.fetch), "vlt_test", rootKey).push(config(source));
    const appendAccess = await scopedAccess(rootKey, ["read", "append"]);
    const readAccess = await scopedAccess(rootKey, ["read"]);

    await expect(new SyncEngine(new StatecaseClient("https://remote.test", "cap", remote.fetch), "vlt_test", { ...appendAccess, expiresAt: 1 }).pull(config(sandbox)))
      .rejects.toThrow("expired");
    await expect(new SyncEngine(new StatecaseClient("https://remote.test", "cap", remote.fetch), "vlt_test", { ...appendAccess, expiresAt: 1 }).push(config(sandbox)))
      .rejects.toThrow("expired");
    await expect(new SyncEngine(new StatecaseClient("https://remote.test", "cap", remote.fetch), "vlt_test", readAccess).push(config(sandbox)))
      .rejects.toThrow("read-only");
    expect(() => new SyncEngine(new StatecaseClient("https://remote.test", "cap", remote.fetch), "other_vault", appendAccess))
      .toThrow("another vault");

    const unauthorized = config(sandbox);
    unauthorized.mappings[0]!.namespace = "drop:private";
    await expect(new SyncEngine(new StatecaseClient("https://remote.test", "cap", remote.fetch), "vlt_test", appendAccess).pull(unauthorized))
      .rejects.toThrow("does not authorize");
    await expect(new SyncEngine(new StatecaseClient("https://remote.test", "cap", remote.fetch), "vlt_test", appendAccess).push(unauthorized))
      .rejects.toThrow("does not authorize");
    const duplicate = config(sandbox);
    duplicate.mappings.push({ ...duplicate.mappings[0]!, id: "drop_duplicate" });
    await expect(new SyncEngine(new StatecaseClient("https://remote.test", "cap", remote.fetch), "vlt_test", appendAccess).push(duplicate))
      .rejects.toThrow("duplicate writable namespace");
    await expect(new SyncEngine(new StatecaseClient("https://remote.test", "cap", remote.fetch), "vlt_test", appendAccess).pull(config(sandbox), false, "nrev_old"))
      .rejects.toMatchObject({ status: 404 });

    const scopedConfig = config(sandbox);
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "cap", remote.fetch), "vlt_test", appendAccess);
    await engine.pull(scopedConfig);
    const strictAppend = structuredClone(scopedConfig);
    strictAppend.mappings[0]!.mode = "append";
    await writeFile(join(sandbox, "existing.txt"), "forbidden append overwrite\n");
    await expect(engine.push(strictAppend)).rejects.toMatchObject({ paths: ["drop:drop_shared:existing.txt:append-only"] });
    await writeFile(join(sandbox, "existing.txt"), "existing\n");
    await writeFile(join(sandbox, "draft.txt"), "draft\n");
    const beforeDryRun = remote.scopedRevisionId;
    expect(await engine.push(scopedConfig, true)).toMatchObject({ outcome: "pushed" });
    expect(remote.scopedRevisionId).toBe(beforeDryRun);
    expect(await engine.push(scopedConfig)).toMatchObject({ outcome: "pushed" });
    expect(await engine.push(scopedConfig)).toMatchObject({ outcome: "unchanged", objects: 0 });
    await rm(join(sandbox, "existing.txt"));
    expect(await engine.push(scopedConfig)).toMatchObject({ outcome: "pushed" });
    const observer = join(base, "observer");
    await mkdir(observer);
    await new SyncEngine(new StatecaseClient("https://remote.test", "cap", remote.fetch), "vlt_test", appendAccess).pull(config(observer));
    await expect(readFile(join(observer, "existing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(observer, "draft.txt"), "utf8")).toBe("draft\n");

    const invalidKeys = structuredClone(appendAccess);
    invalidKeys.namespaceKeys["drop:drop_shared"]!.encryptionKey = "bad";
    await expect(new SyncEngine(new StatecaseClient("https://remote.test", "cap", remote.fetch), "vlt_test", invalidKeys).pull(config(join(base, "bad"))))
      .rejects.toThrow("stored namespace key");

    const emptyRemote = new MemoryRemote();
    const emptyRoot = await randomKey();
    const emptyAccess = await scopedAccess(emptyRoot, ["read", "append"]);
    const emptyRootPath = join(base, "empty-root");
    await mkdir(emptyRootPath);
    const emptyEngine = new SyncEngine(new StatecaseClient("https://remote.test", "cap", emptyRemote.fetch), "vlt_test", emptyAccess);
    expect(await emptyEngine.pull(config(emptyRootPath))).toMatchObject({ outcome: "unchanged", revisionId: null });
    await writeFile(join(emptyRootPath, "first.txt"), "first\n");
    expect(await emptyEngine.push(config(emptyRootPath))).toMatchObject({ outcome: "pushed" });
  });

  it("rejects mismatched, oversized, branching, and cyclic encrypted namespace histories (PR-006)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-scoped-history-"));
    temporary.push(base);
    const rootKey = await randomKey();
    const access = await scopedAccess(rootKey, ["read"]);
    const clientFor = (remote: MemoryRemote) => new SyncEngine(new StatecaseClient("https://remote.test", "cap", remote.fetch), "vlt_test", access);

    const mismatched = new MemoryRemote();
    const mismatchedManifest = namespaceManifest("nrev_body", "snapshot", []);
    const mismatchObject = await storeNamespaceManifest(mismatched, rootKey, mismatchedManifest);
    mismatched.namespaceHeads.set(mismatchedManifest.namespace, { namespace: mismatchedManifest.namespace, revisionId: "nrev_pointer", manifestObjectId: mismatchObject });
    mismatched.scopedRevisionId = "srev_mismatch";
    await expect(clientFor(mismatched).pull(config(join(base, "mismatch")))).rejects.toThrow("do not match");

    const unboundClaims = new MemoryRemote();
    const unboundManifest = namespaceManifest("nrev_unbound", "snapshot", []);
    unboundManifest.entries.push({
      namespace: unboundManifest.namespace,
      logicalPath: "unclaimed.txt",
      entryType: "file",
      objectIds: ["obj_unclaimed"],
      totalSize: 1,
      contentDigest: "digest_unclaimed",
    });
    const unboundObject = await storeNamespaceManifest(unboundClaims, rootKey, unboundManifest);
    unboundClaims.namespaceHeads.set(unboundManifest.namespace, { namespace: unboundManifest.namespace, revisionId: unboundManifest.namespaceRevisionId, manifestObjectId: unboundObject });
    unboundClaims.scopedRevisionId = "srev_unbound";
    await expect(clientFor(unboundClaims).pull(config(join(base, "unbound")))).rejects.toThrow("path claims do not cover");

    const oversized = new MemoryRemote();
    const oversizedManifest = namespaceManifest("nrev_oversized", "snapshot", []);
    oversizedManifest.entries.push({
      namespace: oversizedManifest.namespace,
      logicalPath: "oversized.jsonl",
      entryType: "file",
      objectIds: ["obj_must_not_be_fetched"],
      totalSize: 256 * 1024 * 1024 + 1,
      contentDigest: "digest_oversized",
    });
    const oversizedKeys = await deriveScopeKey(rootKey, oversizedManifest.namespace);
    oversizedManifest.pathClaims.push({ pathId: await testPathId(oversizedKeys.dedupKey, "oversized.jsonl"), mutation: "add" });
    const oversizedObject = await storeNamespaceManifest(oversized, rootKey, oversizedManifest);
    oversized.namespaceHeads.set(oversizedManifest.namespace, {
      namespace: oversizedManifest.namespace,
      revisionId: oversizedManifest.namespaceRevisionId,
      manifestObjectId: oversizedObject,
    });
    oversized.scopedRevisionId = "srev_oversized";
    await expect(clientFor(oversized).pull(config(join(base, "oversized"))))
      .rejects.toThrow("remote file exceeds the local safety limit");

    const duplicateCoverage = new MemoryRemote();
    const duplicateManifest = namespaceManifest("nrev_duplicate_coverage", "snapshot", []);
    duplicateManifest.entries.push(
      { namespace: duplicateManifest.namespace, logicalPath: "first.txt", entryType: "file", objectIds: [], totalSize: 0, contentDigest: "digest_first" },
      { namespace: duplicateManifest.namespace, logicalPath: "second.txt", entryType: "file", objectIds: [], totalSize: 0, contentDigest: "digest_second" },
    );
    const duplicateKeys = await deriveScopeKey(rootKey, duplicateManifest.namespace);
    duplicateManifest.pathClaims.push(
      { pathId: await testPathId(duplicateKeys.dedupKey, "first.txt"), mutation: "add" },
      { pathId: await testPathId(duplicateKeys.dedupKey, `${duplicateManifest.operationId}\0first.txt`), mutation: "add" },
    );
    const duplicateObject = await storeNamespaceManifest(duplicateCoverage, rootKey, duplicateManifest);
    duplicateCoverage.namespaceHeads.set(duplicateManifest.namespace, { namespace: duplicateManifest.namespace, revisionId: duplicateManifest.namespaceRevisionId, manifestObjectId: duplicateObject });
    duplicateCoverage.scopedRevisionId = "srev_duplicate_coverage";
    await expect(clientFor(duplicateCoverage).pull(config(join(base, "duplicate-coverage")))).rejects.toThrow("does not match");

    const branching = new MemoryRemote();
    const branchingManifest = namespaceManifest("nrev_branch", "delta", []);
    const branchObject = await storeNamespaceManifest(branching, rootKey, branchingManifest);
    branching.namespaceHeads.set(branchingManifest.namespace, { namespace: branchingManifest.namespace, revisionId: branchingManifest.namespaceRevisionId, manifestObjectId: branchObject });
    branching.scopedRevisionId = "srev_branch";
    await expect(clientFor(branching).pull(config(join(base, "branch")))).rejects.toThrow("exactly one parent");

    const wrongParent = new MemoryRemote();
    const wrongParentManifest = namespaceManifest("nrev_child", "delta", ["nrev_parent"]);
    const childObject = await storeNamespaceManifest(wrongParent, rootKey, wrongParentManifest);
    wrongParent.namespaceHeads.set(wrongParentManifest.namespace, { namespace: wrongParentManifest.namespace, revisionId: wrongParentManifest.namespaceRevisionId, manifestObjectId: childObject });
    wrongParent.namespaceRevisions.set(`${wrongParentManifest.namespace}\0nrev_parent`, { namespace: wrongParentManifest.namespace, revisionId: "nrev_other", manifestObjectId: childObject, previousRevisionId: null });
    wrongParent.scopedRevisionId = "srev_wrong_parent";
    await expect(clientFor(wrongParent).pull(config(join(base, "wrong-parent")))).rejects.toThrow("pointer does not match");

    const cyclic = new MemoryRemote();
    const cycleA = namespaceManifest("nrev_a", "delta", ["nrev_b"]);
    const cycleB = namespaceManifest("nrev_b", "delta", ["nrev_a"]);
    const objectA = await storeNamespaceManifest(cyclic, rootKey, cycleA);
    const objectB = await storeNamespaceManifest(cyclic, rootKey, cycleB);
    cyclic.namespaceHeads.set(cycleA.namespace, { namespace: cycleA.namespace, revisionId: cycleA.namespaceRevisionId, manifestObjectId: objectA });
    cyclic.namespaceRevisions.set(`${cycleA.namespace}\0nrev_a`, { namespace: cycleA.namespace, revisionId: "nrev_a", manifestObjectId: objectA, previousRevisionId: "nrev_b" });
    cyclic.namespaceRevisions.set(`${cycleA.namespace}\0nrev_b`, { namespace: cycleA.namespace, revisionId: "nrev_b", manifestObjectId: objectB, previousRevisionId: "nrev_a" });
    cyclic.scopedRevisionId = "srev_cycle";
    await expect(clientFor(cyclic).pull(config(join(base, "cycle")))).rejects.toThrow("cycle");

    const noGlobalRevision = new MemoryRemote();
    const snapshot = namespaceManifest("nrev_only", "snapshot", []);
    const snapshotObject = await storeNamespaceManifest(noGlobalRevision, rootKey, snapshot);
    noGlobalRevision.namespaceHeads.set(snapshot.namespace, { namespace: snapshot.namespace, revisionId: snapshot.namespaceRevisionId, manifestObjectId: snapshotObject });
    await expect(clientFor(noGlobalRevision).pull(config(join(base, "fallback")))).resolves.toMatchObject({ revisionId: "nrev_only" });
  });

  it("migrates a pre-1.1 legacy head without overwriting concurrent or unhydrated state", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-legacy-migration-"));
    temporary.push(base);
    const source = join(base, "source");
    const stranger = join(base, "stranger");
    await Promise.all([mkdir(source), mkdir(stranger)]);
    await writeFile(join(source, "legacy.txt"), "legacy\n");
    const remote = new MemoryRemote();
    const rootKey = await randomKey();
    const engine = new SyncEngine(new StatecaseClient("https://remote.test", "device", remote.fetch), "vlt_test", rootKey);
    const local = config(source);
    const legacyRevision = await seedLegacyFile(remote, rootKey, "legacy.txt", new TextEncoder().encode("legacy\n"));
    const legacyKeys = await deriveScopeKey(rootKey, "drop:drop_shared");
    local.applied["drop:drop_shared"] = {
      revisionId: legacyRevision,
      digests: { "legacy.txt": await computeObjectId(legacyKeys.dedupKey, new TextEncoder().encode("legacy\n")) },
    };

    const noMappings = structuredClone(local);
    noMappings.mappings = [];
    noMappings.applied = {};
    delete noMappings.deviceName;
    expect(await engine.push(noMappings)).toMatchObject({ outcome: "unchanged", revisionId: legacyRevision });

    remote.namespaceHeads.clear();
    remote.namespaceRevisions.clear();
    remote.scopedRevisionId = null;
    local.applied["drop:drop_shared"]!.revisionId = legacyRevision;
    expect(await engine.pull(local)).toMatchObject({ outcome: "unchanged", revisionId: legacyRevision });
    expect(await engine.dependencies(legacyRevision)).toEqual([]);
    expect(await engine.push(local, true)).toMatchObject({ outcome: "unchanged", revisionId: legacyRevision });
    expect(await engine.push(local)).toMatchObject({ outcome: "unchanged", revisionId: legacyRevision });
    expect(remote.namespaceHeads.get("drop:drop_shared")).toBeDefined();

    remote.namespaceHeads.clear();
    remote.namespaceRevisions.clear();
    remote.scopedRevisionId = null;
    await expect(engine.push(local, false, { expectedHeadRevisionId: "rev_wrong" })).rejects.toMatchObject({ paths: ["vlt_test:head-advanced-before-resolution"] });

    const duplicate = config(source);
    duplicate.applied["drop:drop_shared"] = { revisionId: legacyRevision, digests: {} };
    duplicate.mappings.push({ ...duplicate.mappings[0]!, id: "drop_duplicate" });
    await expect(engine.push(duplicate)).rejects.toThrow("duplicate writable namespace");

    const unhydrated = config(stranger);
    await expect(engine.push(unhydrated)).rejects.toMatchObject({ paths: ["drop:drop_shared:remote-head-not-applied"] });

    const append = config(source);
    append.applied["drop:drop_shared"] = { revisionId: legacyRevision, digests: {} };
    append.mappings[0]!.mode = "append";
    await writeFile(join(source, "legacy.txt"), "forbidden replacement\n");
    await expect(engine.push(append)).rejects.toMatchObject({ paths: ["drop:drop_shared:legacy.txt:append-only"] });

    const mismatchRevision = remote.revisionId!;
    remote.revisionId = "rev_mismatched_pointer";
    await expect(engine.pull(config(join(base, "mismatch")))).rejects.toThrow("head and manifest revision");
    remote.revisionId = mismatchRevision;

    const resolutionRemote = new MemoryRemote();
    const resolutionRoot = join(base, "resolution");
    await mkdir(resolutionRoot);
    await writeFile(join(resolutionRoot, "winner.txt"), "base\n");
    const resolutionEngine = new SyncEngine(new StatecaseClient("https://remote.test", "device", resolutionRemote.fetch), "vlt_test", rootKey);
    const resolutionConfig = config(resolutionRoot);
    await resolutionEngine.push(resolutionConfig);
    const resolutionLegacyRevision = resolutionRemote.revisionId!;
    resolutionRemote.namespaceHeads.clear();
    resolutionRemote.namespaceRevisions.clear();
    resolutionRemote.scopedRevisionId = null;
    resolutionConfig.applied["drop:drop_shared"]!.revisionId = resolutionLegacyRevision;
    await writeFile(join(resolutionRoot, "winner.txt"), "local winner\n");
    await expect(resolutionEngine.push(resolutionConfig, false, {
      resolveLocalNamespaces: new Set(["drop:drop_shared"]),
      expectedHeadRevisionId: resolutionLegacyRevision,
    })).resolves.toMatchObject({ outcome: "pushed" });
  });

  it("keeps the legacy migration writer deterministic without duplicating identical plaintext objects", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-legacy-dedup-"));
    temporary.push(base);
    const source = join(base, "source");
    await mkdir(source);
    const bytes = new TextEncoder().encode("same bytes\n");
    await Promise.all([writeFile(join(source, "first.txt"), bytes), writeFile(join(source, "second.txt"), bytes)]);
    const remote = new MemoryRemote();
    const rootKey = await randomKey();
    const legacyRevision = await seedLegacyFile(remote, rootKey, "old.txt", new TextEncoder().encode("old\n"));
    const local = config(source);
    delete local.deviceName;
    local.applied["drop:drop_shared"] = { revisionId: legacyRevision, digests: {} };

    const result = await new SyncEngine(new StatecaseClient("https://remote.test", "token", remote.fetch), "vlt_test", rootKey).push(local);

    expect(result).toMatchObject({ outcome: "pushed", files: 2, objects: 2 });
  });
});

function config(path: string): LocalConfig {
  return {
    version: 1,
    apiUrl: "https://remote.test",
    deviceName: "test-device",
    selectedVaultId: "vlt_test",
    mappings: [{ id: "drop_shared", kind: "drop", mode: "two-way", name: "notes", namespace: "drop:drop_shared", path }],
    applied: {},
    workspaces: [],
  };
}

function harnessConfig(path: string, workspacePath: string): LocalConfig {
  return {
    ...config(path),
    mappings: [{ id: "harness_codex_default", kind: "codex", mode: "two-way", name: "Codex", namespace: "harness:codex:default", path }],
    workspaces: [{ id: "ws_test", path: workspacePath, sync: "identity-only" }],
  };
}

function workspaceConfig(path: string): LocalConfig {
  return { ...config(path), mappings: [], workspaces: [{ id: "ws_test", path }] };
}

function workspaceMapping(configValue: LocalConfig): RootMapping {
  const workspace = configValue.workspaces[0]!;
  return {
    id: `workspace_${workspace.id}`,
    kind: "drop",
    mode: "two-way",
    name: workspace.name ?? workspace.id,
    namespace: `workspace:${workspace.id}`,
    path: workspace.path,
  };
}

async function scopedAccess(rootKey: Uint8Array, actions: Array<"read" | "append">) {
  const keys = await deriveScopeKey(rootKey, "drop:drop_shared");
  return {
    vaultId: "vlt_test",
    namespaces: ["drop:drop_shared"],
    actions,
    expiresAt: Date.now() + 60_000,
    namespaceKeys: {
      "drop:drop_shared": {
        encryptionKey: Buffer.from(keys.encryptionKey).toString("base64url"),
        dedupKey: Buffer.from(keys.dedupKey).toString("base64url"),
      },
    },
  };
}

function namespaceManifest(revisionId: string, mode: "snapshot" | "delta", parents: string[]): NamespaceManifestV1 {
  return {
    schemaVersion: 1,
    vaultId: "vlt_test",
    namespace: "drop:drop_shared",
    namespaceRevisionId: revisionId,
    parentNamespaceRevisionIds: parents,
    createdAt: "2026-09-06T10:00:00.000Z",
    createdByDeviceId: "dev_test",
    operationId: `op_${revisionId}`,
    mode,
    entries: [],
    tombstones: [],
    conflicts: [],
    pathClaims: [],
  };
}

async function storeNamespaceManifest(remote: MemoryRemote, rootKey: Uint8Array, manifest: NamespaceManifestV1): Promise<string> {
  const keys = await deriveScopeKey(rootKey, manifest.namespace);
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  const objectId = await computeObjectId(keys.dedupKey, bytes);
  remote.namespaceObjects.set(`${manifest.namespace}\0${objectId}`, await encryptEnvelope({
    plaintext: bytes,
    key: keys.encryptionKey,
    dedupKey: keys.dedupKey,
    context: { vaultId: manifest.vaultId, scopeId: manifest.namespace, compression: "none" },
  }));
  return objectId;
}

async function seedLegacyFile(
  remote: MemoryRemote,
  rootKey: Uint8Array,
  logicalPath: string,
  bytes: Uint8Array,
): Promise<string> {
  const revisionId = "rev_legacy_fixture";
  const namespace = "drop:drop_shared";
  const keys = await deriveScopeKey(rootKey, namespace);
  const objectId = await computeObjectId(keys.dedupKey, bytes);
  remote.objects.set(objectId, await encryptEnvelope({
    plaintext: bytes,
    key: keys.encryptionKey,
    dedupKey: keys.dedupKey,
    context: { vaultId: "vlt_test", scopeId: namespace, compression: "none" },
  }));
  const manifest = {
    schemaVersion: 1 as const,
    vaultId: "vlt_test",
    revisionId,
    parentRevisionIds: [],
    createdAt: "2026-09-06T10:00:00.000Z",
    createdByDeviceId: "dev_legacy",
    operationId: "op_legacy_fixture",
    entries: [{ namespace, logicalPath, entryType: "file" as const, objectIds: [objectId], totalSize: bytes.byteLength, contentDigest: objectId }],
    tombstones: [],
    conflicts: [],
    sessionCapsules: [],
  };
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
  const manifestKeys = await deriveScopeKey(rootKey, "manifest");
  const manifestObjectId = await computeObjectId(manifestKeys.dedupKey, manifestBytes);
  remote.objects.set(manifestObjectId, await encryptEnvelope({
    plaintext: manifestBytes,
    key: manifestKeys.encryptionKey,
    dedupKey: manifestKeys.dedupKey,
    context: { vaultId: "vlt_test", scopeId: "manifest", compression: "none" },
  }));
  remote.revisionId = revisionId;
  remote.manifestObjectId = manifestObjectId;
  remote.revisions.set(revisionId, { revisionId, manifestObjectId, previousRevisionId: null });
  return revisionId;
}

async function publishStreamFixture(
  remote: MemoryRemote,
  rootKey: Uint8Array,
  input: {
    namespace: string;
    logicalPath: string;
    bytes: Uint8Array;
    totalSize?: number;
    contentDigest?: string;
    entryType?: "file" | "workspace-blob";
    workspacePath?: string;
    workspaceLayer?: "index" | "worktree";
    fileMode?: number;
  },
): Promise<void> {
  const keys = await deriveScopeKey(rootKey, input.namespace);
  const objectId = input.bytes.byteLength > 0 ? await computeObjectId(keys.dedupKey, input.bytes) : undefined;
  if (objectId) {
    remote.namespaceObjects.set(`${input.namespace}\0${objectId}`, await encryptEnvelope({
      plaintext: input.bytes,
      key: keys.encryptionKey,
      dedupKey: keys.dedupKey,
      context: { vaultId: "vlt_test", scopeId: input.namespace, compression: "none" },
    }));
  }
  const manifest: NamespaceManifestV1 = {
    schemaVersion: 1,
    vaultId: "vlt_test",
    namespace: input.namespace,
    namespaceRevisionId: `nrev_${Buffer.from(input.logicalPath).toString("base64url").slice(0, 32)}`,
    parentNamespaceRevisionIds: [],
    createdAt: "2026-09-07T10:00:00.000Z",
    createdByDeviceId: "dev_stream_fixture",
    operationId: "op_stream_fixture",
    mode: "snapshot",
    entries: [{
      namespace: input.namespace,
      logicalPath: input.logicalPath,
      entryType: input.entryType ?? "file",
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(input.workspaceLayer ? { workspaceLayer: input.workspaceLayer } : {}),
      ...(input.fileMode !== undefined ? { fileMode: input.fileMode } : {}),
      objectIds: objectId ? [objectId] : [],
      totalSize: input.totalSize ?? input.bytes.byteLength,
      contentDigest: input.contentDigest ?? await computeObjectId(keys.dedupKey, input.bytes),
      chunking: { strategy: "jsonl-records", targetSize: 4 * 1024 * 1024, maxSize: 4 * 1024 * 1024 },
    }],
    tombstones: [],
    conflicts: [],
    pathClaims: [{ pathId: await testPathId(keys.dedupKey, input.logicalPath), mutation: "add" }],
  };
  const manifestObjectId = await storeNamespaceManifest(remote, rootKey, manifest);
  remote.namespaceHeads.set(input.namespace, { namespace: input.namespace, revisionId: manifest.namespaceRevisionId, manifestObjectId });
  remote.scopedRevisionId = `srev_${manifest.namespaceRevisionId}`;
}

async function testPathId(dedupKey: Uint8Array, logicalPath: string): Promise<string> {
  return computeObjectId(dedupKey, new TextEncoder().encode(`statecase:path:v1\0${logicalPath}`));
}

async function rewriteCurrentCapsulePins(
  remote: MemoryRemote,
  rootKey: Uint8Array,
  sessionCapsuleId: string,
  pins: { workspaceRevisionId: string; dropRevisionIds: Record<string, string> },
): Promise<void> {
  const namespace = "harness:codex:default";
  const head = remote.namespaceHeads.get(namespace)!;
  const keys = await deriveScopeKey(rootKey, namespace);
  const manifest = await readTestNamespaceManifest(remote, rootKey, head);
  const capsule = manifest.sessionCapsules?.find((candidate) => candidate.sessionCapsuleId === sessionCapsuleId);
  if (!capsule) throw new Error("test session capsule is missing");
  capsule.workspace.capsuleRevisionId = pins.workspaceRevisionId;
  capsule.drops = capsule.drops.map((drop) => ({
    ...drop,
    revisionId: pins.dropRevisionIds[drop.dropId] ?? drop.revisionId,
  }));
  const nextBytes = new TextEncoder().encode(canonicalJson(manifest));
  const manifestObjectId = await computeObjectId(keys.dedupKey, nextBytes);
  remote.namespaceObjects.set(`${namespace}\0${manifestObjectId}`, await encryptEnvelope({
    plaintext: nextBytes,
    key: keys.encryptionKey,
    dedupKey: keys.dedupKey,
    context: { vaultId: "vlt_test", scopeId: namespace, compression: "none" },
  }));
  const nextHead = { ...head, manifestObjectId };
  remote.namespaceHeads.set(namespace, nextHead);
  const current = remote.scopedRevisions.get(remote.scopedRevisionId!)!;
  remote.scopedRevisions.set(current.revisionId, {
    ...current,
    namespaces: current.namespaces.map((candidate) => candidate.namespace === namespace ? nextHead : candidate),
  });
}

async function readTestNamespaceManifest(
  remote: MemoryRemote,
  rootKey: Uint8Array,
  head: { namespace: string; manifestObjectId: string },
): Promise<NamespaceManifestV1> {
  const keys = await deriveScopeKey(rootKey, head.namespace);
  const envelope = remote.namespaceObjects.get(`${head.namespace}\0${head.manifestObjectId}`)!;
  const plaintext = await decryptEnvelope({
    envelope,
    key: keys.encryptionKey,
    dedupKey: keys.dedupKey,
    expected: { vaultId: "vlt_test", scopeId: head.namespace, compression: "none" },
  });
  return namespaceManifestSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
}

async function initializeRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "tracked.txt"), "baseline\n");
  await runFile("git", ["init", "-q", path]);
  await runFile("git", ["-C", path, "add", "tracked.txt"]);
  await runFile("git", ["-C", path, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "baseline"]);
}

class MemoryRemote {
  readonly objects = new Map<string, Uint8Array>();
  readonly namespaceObjects = new Map<string, Uint8Array>();
  readonly namespaceHeads = new Map<string, { namespace: string; revisionId: string; manifestObjectId: string; keyEpoch?: number }>();
  readonly namespaceRevisions = new Map<string, { namespace: string; revisionId: string; manifestObjectId: string; keyEpoch?: number; previousRevisionId: string | null }>();
  readonly scopedRevisions = new Map<string, { revisionId: string; previousRevisionId: string | null; namespaces: Array<{ namespace: string; revisionId: string; manifestObjectId: string; keyEpoch?: number }> }>();
  readonly revisions = new Map<string, { revisionId: string; manifestObjectId: string; previousRevisionId: string | null }>();
  revisionId: string | null = null;
  scopedRevisionId: string | null = null;
  manifestObjectId: string | null = null;
  plaintext = "";
  readonly namespaceObjectWrites: string[] = [];
  readonly namespaceCommitRequests: Array<{
    vaultRevisionId: string;
    updates: Array<{
      namespace: string;
      baseNamespaceRevisionId: string | null;
      namespaceRevisionId: string;
      manifestObjectId: string;
      keyEpoch?: number;
      retainedVaultRevisionIds?: string[];
    }>;
  }> = [];
  allowLegacyReads = true;
  failNextNamespaceCommit = false;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const scopedRevision = /^\/v1\/vaults\/vlt_test\/scoped-revisions\/([^/]+)$/u.exec(url.pathname);
    if (scopedRevision) {
      const value = this.scopedRevisions.get(scopedRevision[1]);
      return value ? Response.json(value) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    const namespaceRevision = /^\/v1\/vaults\/vlt_test\/namespaces\/([^/]+)\/revisions\/([^/]+)$/u.exec(url.pathname);
    if (namespaceRevision) {
      const value = this.namespaceRevisions.get(`${decodeURIComponent(namespaceRevision[1])}\0${namespaceRevision[2]}`);
      return value ? Response.json(value) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    const namespaceObject = /^\/v1\/vaults\/vlt_test\/namespaces\/([^/]+)\/objects\/([^/]+)$/u.exec(url.pathname);
    if (namespaceObject) {
      const namespace = decodeURIComponent(namespaceObject[1]);
      const key = `${namespace}\0${namespaceObject[2]}`;
      if (method === "PUT") {
        const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
        this.namespaceObjectWrites.push(key);
        this.namespaceObjects.set(key, bytes);
        this.plaintext += new TextDecoder().decode(bytes);
        return Response.json({ created: true, size: bytes.byteLength }, { status: 201 });
      }
      const bytes = this.namespaceObjects.get(key);
      return bytes ? new Response(bytes) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    if (url.pathname.endsWith("/namespaces")) return Response.json({ revisionId: this.scopedRevisionId, namespaces: [...this.namespaceHeads.values()] });
    if (url.pathname.endsWith("/namespace-commits")) {
      const request = JSON.parse(String(init?.body)) as (typeof this.namespaceCommitRequests)[number];
      this.namespaceCommitRequests.push(structuredClone(request));
      if (this.failNextNamespaceCommit) {
        this.failNextNamespaceCommit = false;
        return Response.json({ error: { code: "STALE_BASE", message: "injected advancement" } }, { status: 409 });
      }
      const stale = request.updates.filter((update) => (this.namespaceHeads.get(update.namespace)?.revisionId ?? null) !== update.baseNamespaceRevisionId);
      if (stale.length > 0) return Response.json({ error: { code: "STALE_BASE", message: "advanced" } }, { status: 409 });
      for (const update of request.updates) {
        const previousRevisionId = this.namespaceHeads.get(update.namespace)?.revisionId ?? null;
        const head = { namespace: update.namespace, revisionId: update.namespaceRevisionId, manifestObjectId: update.manifestObjectId, keyEpoch: update.keyEpoch ?? 1 };
        this.namespaceHeads.set(update.namespace, head);
        this.namespaceRevisions.set(`${update.namespace}\0${update.namespaceRevisionId}`, { ...head, previousRevisionId });
      }
      const previousRevisionId = this.scopedRevisionId;
      this.scopedRevisionId = request.vaultRevisionId;
      this.scopedRevisions.set(request.vaultRevisionId, { revisionId: request.vaultRevisionId, previousRevisionId, namespaces: [...this.namespaceHeads.values()] });
      return Response.json({ outcome: "committed", revisionId: request.vaultRevisionId });
    }
    const object = /^\/v1\/vaults\/vlt_test\/objects\/([^/]+)$/u.exec(url.pathname);
    if (object && method === "PUT") {
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      this.objects.set(object[1], bytes);
      this.plaintext += new TextDecoder().decode(bytes);
      return Response.json({ created: true, size: bytes.byteLength }, { status: 201 });
    }
    if (object) {
      if (!this.allowLegacyReads) return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
      const bytes = this.objects.get(object[1]);
      return bytes ? new Response(bytes) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    if (url.pathname.endsWith("/head")) return Response.json({ revisionId: this.revisionId, manifestObjectId: this.manifestObjectId });
    const revision = /\/revisions\/([^/]+)$/u.exec(url.pathname);
    if (revision) {
      const value = this.revisions.get(revision[1]);
      return value ? Response.json(value) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    if (url.pathname.endsWith("/commits")) {
      const request = JSON.parse(String(init?.body)) as { baseRevisionId: string | null; revisionId: string; manifestObjectId: string };
      if (request.baseRevisionId !== this.revisionId) return Response.json({ error: { code: "STALE_BASE", message: "advanced" } }, { status: 409 });
      this.revisionId = request.revisionId;
      this.manifestObjectId = request.manifestObjectId;
      this.revisions.set(request.revisionId, { revisionId: request.revisionId, manifestObjectId: request.manifestObjectId, previousRevisionId: request.baseRevisionId });
      return Response.json({ outcome: "committed", revisionId: request.revisionId });
    }
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  };
}
