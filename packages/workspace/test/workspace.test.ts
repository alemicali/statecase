import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { applyWorkspaceCapsule, applyWorkspaceTransaction, assertWorkspaceDestination, captureWorkspace, workspaceMatchesCapsule } from "../src/index.js";

const run = promisify(execFile);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("exact Git workspace capsules (WS-010..WS-018, WS-025..WS-026)", () => {
  it("records a clean baseline without transferring tracked contents", async () => {
    const root = await repository("clean");
    const captured = await captureWorkspace(root);
    expect(captured.capsule).toMatchObject({ schemaVersion: 1, baseCommit: (await git(root, "rev-parse", "HEAD")).trim(), records: [] });
    expect(captured.blobs).toEqual([]);
  });

  it("round-trips staged and differently modified content, additions, deletions, binaries, empties, and executable mode", async () => {
    const source = await repository("source");
    const target = await repository("target");
    await writeFile(join(source, "tracked.txt"), "staged version\n");
    await git(source, "add", "tracked.txt");
    await writeFile(join(source, "tracked.txt"), "worktree version\n");
    await git(source, "rm", "deleted.txt");
    await writeFile(join(source, "added.txt"), "staged addition\n");
    await git(source, "add", "added.txt");
    await writeFile(join(source, "untracked.bin"), Uint8Array.of(0, 255, 1, 2));
    await writeFile(join(source, "empty.txt"), "");
    await writeFile(join(source, "script.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(source, "script.sh"), 0o755);
    await mkdir(join(source, "links"));
    await writeFile(join(source, "links", "target.txt"), "linked\n");
    await symlink("target.txt", join(source, "links", "portable"));
    await symlink("links/target.txt", join(source, "staged-link"));
    await git(source, "add", "staged-link");

    const captured = await captureWorkspace(source);
    await applyWorkspaceCapsule(target, captured, { materialize });

    expect(await git(target, "show", ":tracked.txt")).toBe("staged version\n");
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("worktree version\n");
    expect(await git(target, "show", ":added.txt")).toBe("staged addition\n");
    await expect(readFile(join(target, "deleted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(target, "untracked.bin"))).toEqual(Buffer.from([0, 255, 1, 2]));
    expect((await readFile(join(target, "empty.txt"))).byteLength).toBe(0);
    if (process.platform !== "win32") expect((await lstat(join(target, "script.sh"))).mode & 0o111).not.toBe(0);
    expect((await lstat(join(target, "links", "portable"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(target, "links", "portable"))).toBe("target.txt");
    expect(await readlink(join(target, "staged-link"))).toBe("links/target.txt");
    expect(await git(target, "status", "--porcelain=v1", "-z")).toBe(await git(source, "status", "--porcelain=v1", "-z"));
  });

  it("refuses a dirty destination or mismatched baseline without changing it", async () => {
    const source = await repository("guard-source");
    const dirtyTarget = await repository("guard-target");
    await writeFile(join(source, "tracked.txt"), "remote change\n");
    const captured = await captureWorkspace(source);
    await writeFile(join(dirtyTarget, "tracked.txt"), "local change\n");
    await expect(applyWorkspaceCapsule(dirtyTarget, captured, { materialize })).rejects.toThrow("destination is dirty");
    expect(await readFile(join(dirtyTarget, "tracked.txt"), "utf8")).toBe("local change\n");

    await git(dirtyTarget, "add", "tracked.txt");
    await git(dirtyTarget, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "different");
    await expect(applyWorkspaceCapsule(dirtyTarget, captured, { materialize })).rejects.toThrow("baseline does not match");
  });

  it("restores the original Git index when filesystem materialization fails", async () => {
    const source = await repository("rollback-source");
    const target = await repository("rollback-target");
    await writeFile(join(source, "tracked.txt"), "staged remote\n");
    await git(source, "add", "tracked.txt");
    const captured = await captureWorkspace(source);
    await expect(applyWorkspaceCapsule(target, captured, {
      materialize: async () => { throw new Error("disk full"); },
    })).rejects.toThrow("disk full");
    expect(await git(target, "show", ":tracked.txt")).toBe("baseline tracked\n");
    expect(await git(target, "status", "--porcelain=v1")).toBe("");
  });

  it("removes a newly-created unborn index again when apply fails", async () => {
    const source = await unbornRepository("rollback-unborn-source");
    const target = await unbornRepository("rollback-unborn-target");
    await writeFile(join(source, "new.txt"), "new\n");
    await git(source, "add", "new.txt");
    const captured = await captureWorkspace(source);
    await expect(applyWorkspaceCapsule(target, captured, {
      materialize: async () => { throw new Error("injected failure"); },
    })).rejects.toThrow("injected failure");
    expect(await git(target, "status", "--porcelain=v1")).toBe("");
  });

  it("restores every index when a cross-namespace filesystem transaction fails", async () => {
    const sourceA = await repository("atomic-source-a");
    const sourceB = await repository("atomic-source-b");
    const targetA = await repository("atomic-target-a");
    const targetB = await repository("atomic-target-b");
    await writeFile(join(sourceA, "tracked.txt"), "staged a\n");
    await writeFile(join(sourceB, "tracked.txt"), "staged b\n");
    await git(sourceA, "add", "tracked.txt");
    await git(sourceB, "add", "tracked.txt");
    let materializations = 0;

    await expect(applyWorkspaceTransaction(
      [
        { root: targetA, captured: await captureWorkspace(sourceA) },
        { root: targetB, captured: await captureWorkspace(sourceB) },
      ],
      { writes: [{ path: join(targetA, "ordinary.txt"), bytes: new TextEncoder().encode("ordinary") }], deletes: [] },
      {
        materialize: async (transaction) => {
          materializations += 1;
          expect(transaction.writes).toHaveLength(3);
          throw new Error("whole revision failed");
        },
      },
    )).rejects.toThrow("whole revision failed");

    expect(materializations).toBe(1);
    expect(await git(targetA, "show", ":tracked.txt")).toBe("baseline tracked\n");
    expect(await git(targetB, "show", ":tracked.txt")).toBe("baseline tracked\n");
    expect(await git(targetA, "status", "--porcelain=v1")).toBe("");
    expect(await git(targetB, "status", "--porcelain=v1")).toBe("");
  });

  it("rejects duplicate workspace roots and preserves initial transaction symlinks", async () => {
    const root = await repository("transaction-boundaries");
    const captured = await captureWorkspace(root);
    await expect(applyWorkspaceTransaction(
      [{ root, captured }, { root, captured }],
      { writes: [], deletes: [] },
      { materialize },
    )).rejects.toThrow("duplicate workspace transaction root");

    const linkPath = join(root, "portable-link");
    await applyWorkspaceTransaction(
      [],
      { writes: [], symlinks: [{ path: linkPath, target: "tracked.txt" }], deletes: [] },
      { materialize },
    );
    expect(await readlink(linkPath)).toBe("tracked.txt");
  });

  it("captures detached HEAD deterministically and rejects an unmerged index", async () => {
    const root = await repository("detached");
    await git(root, "checkout", "--detach", "-q");
    expect((await captureWorkspace(root)).capsule.headRef).toBeNull();

    await writeFile(join(root, "conflict.txt"), "ours\n");
    const blob = (await gitWithInput(root, ["hash-object", "-w", "--stdin"], "base\n")).trim();
    await gitWithInput(root, ["update-index", "--index-info"], `100644 ${blob} 1\tconflict.txt\n100644 ${blob} 2\tconflict.txt\n`);
    await expect(captureWorkspace(root)).rejects.toThrow("unmerged index");
  });

  it("rejects a changed symlink that escapes the workspace", async () => {
    const root = await repository("unsafe-link");
    await symlink("../../outside", join(root, "escape"));
    await expect(captureWorkspace(root)).rejects.toThrow("unsafe workspace symlink");
  });

  it("round-trips an unborn branch without manufacturing a baseline commit", async () => {
    const source = await unbornRepository("unborn-source");
    const target = await unbornRepository("unborn-target");
    await writeFile(join(source, "staged.txt"), "staged\n");
    await git(source, "add", "staged.txt");
    await writeFile(join(source, "staged.txt"), "worktree\n");
    await writeFile(join(source, "untracked.txt"), "untracked\n");

    const captured = await captureWorkspace(source);
    expect(captured.capsule.baseCommit).toBeNull();
    await applyWorkspaceCapsule(target, captured, { materialize });

    expect(await git(target, "show", ":staged.txt")).toBe("staged\n");
    expect(await readFile(join(target, "staged.txt"), "utf8")).toBe("worktree\n");
    expect(await readFile(join(target, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(await git(target, "status", "--porcelain=v1", "-z")).toBe(await git(source, "status", "--porcelain=v1", "-z"));
  });

  it("compares capsules semantically after canonical JSON key reordering", async () => {
    const root = await repository("canonical-match");
    await writeFile(join(root, "tracked.txt"), "changed\n");
    const captured = await captureWorkspace(root);
    const reordered = structuredClone(captured);
    // Simulate canonical JSON by rebuilding nested objects with a different insertion order.
    reordered.capsule = {
      baseCommit: captured.capsule.baseCommit,
      headRef: captured.capsule.headRef,
      records: captured.capsule.records.map((record) => ({ worktree: { ...record.worktree }, index: { ...record.index }, path: record.path })),
      schemaVersion: 1,
    };
    reordered.blobs = [...captured.blobs].reverse();
    expect(await workspaceMatchesCapsule(root, reordered)).toBe(true);
  });

  it("rejects malformed capsule metadata and unreferenced blobs before mutation", async () => {
    const source = await repository("validation-source");
    const target = await repository("validation-target");
    await writeFile(join(source, "tracked.txt"), "changed\n");
    const captured = await captureWorkspace(source);
    const invalidState = structuredClone(captured);
    invalidState.capsule.records[0]!.worktree.state = "unexpected" as "content";
    await expect(assertWorkspaceDestination(target, invalidState)).rejects.toThrow("workspace state");

    const invalidMode = structuredClone(captured);
    invalidMode.capsule.records[0]!.worktree.mode = 0o100600;
    await expect(assertWorkspaceDestination(target, invalidMode)).rejects.toThrow("workspace mode");

    const extraBlob = structuredClone(captured);
    extraBlob.blobs.push({ ...extraBlob.blobs[0]!, path: "unreferenced.txt" });
    await expect(assertWorkspaceDestination(target, extraBlob)).rejects.toThrow("unreferenced workspace blob");

    const mismatchedBlob = structuredClone(captured);
    mismatchedBlob.blobs[0]!.mode = 0o100755;
    await expect(assertWorkspaceDestination(target, mismatchedBlob)).rejects.toThrow("metadata does not match");
    expect(await git(target, "status", "--porcelain=v1")).toBe("");
  });

  it("rejects corrupt blob bytes and inbound escaping symlinks without mutation", async () => {
    const source = await repository("digest-source");
    const target = await repository("digest-target");
    await writeFile(join(source, "tracked.txt"), "changed\n");
    const corrupt = structuredClone(await captureWorkspace(source));
    corrupt.blobs[0]!.bytes[0] ^= 0xff;
    await expect(applyWorkspaceCapsule(target, corrupt, { materialize })).rejects.toThrow("digest does not match");

    const unsafeLink = structuredClone(await captureWorkspace(source));
    const bytes = new TextEncoder().encode("../../escape");
    const oid = (await gitWithInput(source, ["hash-object", "--stdin"], "../../escape")).trim();
    unsafeLink.capsule.records.push({
      path: "link",
      index: { state: "absent" },
      worktree: { state: "content", mode: 0o120000, oid },
    });
    unsafeLink.capsule.records.sort((left, right) => left.path.localeCompare(right.path, "en"));
    unsafeLink.blobs.push({ layer: "worktree", path: "link", bytes, mode: 0o120000, oid });
    await expect(applyWorkspaceCapsule(target, unsafeLink, { materialize })).rejects.toThrow("symlink target escapes");
    expect(await git(target, "status", "--porcelain=v1")).toBe("");
  });

  it("validates every untrusted capsule boundary before invoking Git mutation", async () => {
    const source = await repository("boundary-source");
    const target = await repository("boundary-target");
    await writeFile(join(source, "tracked.txt"), "changed\n");
    const valid = await captureWorkspace(source);
    const mutations: Array<[string, (value: typeof valid) => void]> = [
      ["version", (value) => { value.capsule.schemaVersion = 2 as 1; }],
      ["baseline", (value) => { value.capsule.baseCommit = "bad"; }],
      ["empty ref", (value) => { value.capsule.headRef = ""; }],
      ["control ref", (value) => { value.capsule.headRef = "bad\u007fref"; }],
      ["records shape", (value) => { value.capsule.records = {} as never[]; }],
      ["record shape", (value) => { value.capsule.records = [null as never]; }],
      ["long path", (value) => { value.capsule.records[0]!.path = "x".repeat(4097); value.blobs[0]!.path = value.capsule.records[0]!.path; }],
      ["unsafe path", (value) => { value.capsule.records[0]!.path = "../escape"; }],
      ["duplicate path", (value) => { value.capsule.records.push(structuredClone(value.capsule.records[0]!)); }],
      ["wrong order", (value) => { value.capsule.records.unshift({ path: "z", index: { state: "absent" }, worktree: { state: "absent" } }); }],
      ["state relation", (value) => { value.capsule.records[0]!.index = { state: "absent" }; value.capsule.records[0]!.worktree = { state: "index" }; value.blobs = []; }],
      ["index-only state", (value) => { value.capsule.records[0]!.index = { state: "index" as never }; }],
      ["worktree-only state", (value) => { value.capsule.records[0]!.worktree = { state: "base" as never }; }],
      ["unexpected metadata", (value) => { value.capsule.records[0]!.index = { state: "base", mode: 0o100644 } as never; }],
      ["bad object id", (value) => { value.capsule.records[0]!.worktree.oid = "not-an-oid"; }],
      ["submodule mode", (value) => { value.capsule.records[0]!.worktree = { state: "submodule", mode: 0o100644, oid: "0".repeat(40) }; value.blobs = []; }],
      ["initialized submodule", (value) => { value.capsule.records[0]!.worktree = { state: "submodule", mode: 0o160000, oid: "0".repeat(40) }; value.blobs = []; }],
      ["blob shape", (value) => { value.blobs = [null as never]; }],
      ["blob layer", (value) => { value.blobs[0]!.layer = "other" as never; }],
      ["duplicate blob", (value) => { value.blobs.push(structuredClone(value.blobs[0]!)); }],
      ["missing blob", (value) => { value.blobs = []; }],
    ];
    for (const [name, mutate] of mutations) {
      const value = structuredClone(valid);
      mutate(value);
      await expect(assertWorkspaceDestination(target, value), name).rejects.toBeInstanceOf(Error);
    }
    await expect(assertWorkspaceDestination(target, null as never)).rejects.toThrow("invalid workspace capsule");
    await expect(assertWorkspaceDestination(join(target, "missing"), valid)).rejects.toThrow("not a Git working tree");
    expect(await workspaceMatchesCapsule(join(target, "missing"), valid)).toBe(false);
    expect(await git(target, "status", "--porcelain=v1")).toBe("");
  });

  it("preserves a staged gitlink without copying nested repository contents", async () => {
    const source = await repository("gitlink-source");
    const target = await repository("gitlink-target");
    const oid = (await git(source, "rev-parse", "HEAD")).trim();
    await git(source, "update-index", "--add", "--cacheinfo", "160000", oid, "module");
    const captured = await captureWorkspace(source);
    expect(captured.blobs).toEqual([]);
    expect(captured.capsule.records).toContainEqual({
      path: "module",
      index: { state: "submodule", mode: 0o160000, oid },
      worktree: { state: "absent" },
    });
    await applyWorkspaceCapsule(target, captured, { materialize });
    expect(await git(target, "ls-files", "--stage", "module")).toContain(`160000 ${oid}`);
    await expect(readFile(join(target, "module"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed instead of pretending an initialized submodule worktree was captured", async () => {
    const root = await repository("initialized-gitlink");
    const oid = (await git(root, "rev-parse", "HEAD")).trim();
    await git(root, "update-index", "--add", "--cacheinfo", "160000", oid, "module");
    await mkdir(join(root, "module"));
    await expect(captureWorkspace(root)).rejects.toThrow("initialized submodule worktrees are not supported");
  });
});

async function repository(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `statecase-workspace-${name}-`));
  temporary.push(root);
  await writeFile(join(root, "tracked.txt"), "baseline tracked\n");
  await writeFile(join(root, "deleted.txt"), "baseline deleted\n");
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "baseline");
  return root;
}

async function unbornRepository(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `statecase-workspace-${name}-`));
  temporary.push(root);
  await git(root, "init", "-q");
  return root;
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
    },
  })).stdout;
}

async function materialize(transaction: {
  writes: Array<{ path: string; bytes: Uint8Array; mode?: number }>;
  deletes: string[];
  symlinks?: Array<{ path: string; target: string }>;
}): Promise<void> {
  for (const path of transaction.deletes) await rm(path, { force: true });
  for (const write of transaction.writes) {
    await mkdir(dirname(write.path), { recursive: true });
    await writeFile(write.path, write.bytes);
    if (write.mode !== undefined) await chmod(write.path, write.mode);
  }
  for (const link of transaction.symlinks ?? []) {
    await mkdir(dirname(link.path), { recursive: true });
    await symlink(link.target, link.path);
  }
}

function gitWithInput(root: string, args: string[], input: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("git", ["-C", root, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(stderr)));
    child.stdin.end(input);
  });
}
