import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { randomKey } from "@statecase/crypto";
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
    expect(remote.plaintext).not.toContain("portable context");
    expect(remote.plaintext).not.toContain("must-not-leak");
    expect(await b.pull(configB)).toMatchObject({ outcome: "pulled", files: 1 });
    expect(await readFile(join(second, "nested", "context.md"), "utf8")).toBe("portable context\n");
    await expect(readFile(join(second, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(second, "link.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await b.pull(configB)).outcome).toBe("unchanged");
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
    await expect(targetEngine.pull(targetConfig)).resolves.toMatchObject({ outcome: "pulled" });
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
    const revision = remote.revisionId;
    expect(first.outcome).toBe("pushed");
    expect(await engine.push(local)).toMatchObject({ outcome: "unchanged", revisionId: revision, objects: 0, bytes: 0 });
    expect(remote.revisionId).toBe(revision);
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
    expect(remote.revisionId).toBe(second.revisionId);
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

async function initializeRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "tracked.txt"), "baseline\n");
  await runFile("git", ["init", "-q", path]);
  await runFile("git", ["-C", path, "add", "tracked.txt"]);
  await runFile("git", ["-C", path, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "baseline"]);
}

class MemoryRemote {
  readonly objects = new Map<string, Uint8Array>();
  readonly revisions = new Map<string, { revisionId: string; manifestObjectId: string; previousRevisionId: string | null }>();
  revisionId: string | null = null;
  manifestObjectId: string | null = null;
  plaintext = "";

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const object = /^\/v1\/vaults\/vlt_test\/objects\/([^/]+)$/u.exec(url.pathname);
    if (object && method === "PUT") {
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      this.objects.set(object[1], bytes);
      this.plaintext += new TextDecoder().decode(bytes);
      return Response.json({ created: true, size: bytes.byteLength }, { status: 201 });
    }
    if (object) {
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
