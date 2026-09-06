import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { computeObjectId, deriveScopeKey, encryptEnvelope, randomKey } from "@statecase/crypto";
import { canonicalJson, type NamespaceManifestV1 } from "@statecase/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { StatecaseClient } from "../src/client.js";
import type { LocalConfig } from "../src/config.js";
import { SyncConflict, SyncEngine } from "../src/sync.js";

const temporary: string[] = [];
const runFile = promisify(execFile);
afterEach(async () => {
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
    expect((await b.pull(configB)).outcome).toBe("unchanged");
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
      { type: "tool_call", name: "read_file", arguments: { path: "ignored.txt" } },
      { type: "tool_call", name: "read_file", arguments: { path: join(drop, "brief.md") } },
      { type: "tool_call", name: "read_file", arguments: { path: join(drop, ".env") } },
      { type: "tool_call", name: "read_file", arguments: { path: "/outside/not-mapped.txt" } },
    ];
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
    await engine.push(local);
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
    };
    const hydrated = await engine.hydrate(targetConfig, retained.sessionCapsuleId, { mode: "warn" });
    expect(hydrated.result.revisionId).toBe(pushed.revisionId);
    expect(hydrated.warnings).toEqual(["/outside/not-mapped.txt", "drop_reference/.env", "ignored.txt"]);
    expect(await readFile(join(targetDrop, "brief.md"), "utf8")).toBe("portable brief\n");
    expect(await readFile(join(targetWorkspace, "changed.txt"), "utf8")).toBe("uncommitted context\n");

    await writeFile(join(harness, "sessions", "2026", "native-01.jsonl"), `${session.concat([
      { type: "tool_call", name: "read_file", arguments: { path: "changed.txt" } },
    ]).map((record) => JSON.stringify(record)).join("\n")}\n`);
    const scopedPush = await engine.push(local);
    const updated = (await engine.dependencies()).find((report) => report.sessionKey.endsWith(":native-01"))!;
    expect(updated.harnessRevisionId).toBe(scopedPush.revisionId);
    expect(updated.workspace.capsuleRevisionId).toBe(scopedPush.revisionId);
    expect(updated.dependencies.find((dependency) => dependency.logicalPath === "changed.txt")).toMatchObject({ status: "resolved" });
  });

  it("carries modified and untracked Git work over a clean baseline at a different path", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-git-overlay-"));
    temporary.push(base);
    const source = join(base, "home", "project");
    const target = join(base, "srv", "project");
    await Promise.all([initializeRepository(source), initializeRepository(target)]);
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
    await Promise.all([initializeRepository(source), initializeRepository(target), mkdir(ordinary)]);
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

  it("rejects mismatched, branching, and cyclic encrypted namespace histories", async () => {
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
    await engine.push(local);
    const legacyRevision = remote.revisionId!;

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

async function testPathId(dedupKey: Uint8Array, logicalPath: string): Promise<string> {
  return computeObjectId(dedupKey, new TextEncoder().encode(`statecase:path:v1\0${logicalPath}`));
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
  readonly namespaceHeads = new Map<string, { namespace: string; revisionId: string; manifestObjectId: string }>();
  readonly namespaceRevisions = new Map<string, { namespace: string; revisionId: string; manifestObjectId: string; previousRevisionId: string | null }>();
  readonly scopedRevisions = new Map<string, { revisionId: string; previousRevisionId: string | null; namespaces: Array<{ namespace: string; revisionId: string; manifestObjectId: string }> }>();
  readonly revisions = new Map<string, { revisionId: string; manifestObjectId: string; previousRevisionId: string | null }>();
  revisionId: string | null = null;
  scopedRevisionId: string | null = null;
  manifestObjectId: string | null = null;
  plaintext = "";
  allowLegacyReads = true;

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
        this.namespaceObjects.set(key, bytes);
        this.plaintext += new TextDecoder().decode(bytes);
        return Response.json({ created: true, size: bytes.byteLength }, { status: 201 });
      }
      const bytes = this.namespaceObjects.get(key);
      return bytes ? new Response(bytes) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    if (url.pathname.endsWith("/namespaces")) return Response.json({ revisionId: this.scopedRevisionId, namespaces: [...this.namespaceHeads.values()] });
    if (url.pathname.endsWith("/namespace-commits")) {
      const request = JSON.parse(String(init?.body)) as { vaultRevisionId: string; updates: Array<{ namespace: string; baseNamespaceRevisionId: string | null; namespaceRevisionId: string; manifestObjectId: string }> };
      const stale = request.updates.filter((update) => (this.namespaceHeads.get(update.namespace)?.revisionId ?? null) !== update.baseNamespaceRevisionId);
      if (stale.length > 0) return Response.json({ error: { code: "STALE_BASE", message: "advanced" } }, { status: 409 });
      for (const update of request.updates) {
        const previousRevisionId = this.namespaceHeads.get(update.namespace)?.revisionId ?? null;
        const head = { namespace: update.namespace, revisionId: update.namespaceRevisionId, manifestObjectId: update.manifestObjectId };
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
