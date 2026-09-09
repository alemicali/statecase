import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createEmergencySnapshot, inspectEmergencySnapshot, restoreEmergencySnapshot } from "../src/emergency.js";

const temporary: string[] = [];
const run = promisify(execFile);

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persistent local restore snapshots (BK-009)", () => {
  it("restores replaced, deleted, symlink, and originally absent targets byte-exactly", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-"));
    temporary.push(base);
    const statecaseHome = join(base, "statecase");
    const targetRoot = join(base, "target");
    await mkdir(targetRoot);
    const replaced = join(targetRoot, "replaced.txt");
    const deleted = join(targetRoot, "nested", "deleted.txt");
    const linked = join(targetRoot, "linked");
    const created = join(targetRoot, "created.txt");
    await mkdir(join(targetRoot, "nested"));
    await writeFile(replaced, "before replacement", { mode: 0o640 });
    await writeFile(deleted, "before deletion");
    await symlink("replaced.txt", linked);

    const snapshot = await createEmergencySnapshot({
      id: "restore_test",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome,
      targetRoot,
      paths: [created, deleted, linked, replaced],
    });
    await writeFile(replaced, "after replacement");
    await (await import("node:fs/promises")).rm(deleted);
    await (await import("node:fs/promises")).rm(linked);
    await writeFile(linked, "not a symlink anymore");
    await writeFile(created, "new file");

    await restoreEmergencySnapshot(snapshot.path);

    expect(await readFile(replaced, "utf8")).toBe("before replacement");
    expect((await lstat(replaced)).mode & 0o777).toBe(0o640);
    expect(await readFile(deleted, "utf8")).toBe("before deletion");
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await readlink(linked)).toBe("replaced.txt");
    await expect(readFile(created)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates every backup before mutation and rejects targets outside the selected root", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-tamper-"));
    temporary.push(base);
    const targetRoot = join(base, "target");
    await mkdir(targetRoot);
    const target = join(targetRoot, "value.txt");
    await writeFile(target, "original");
    const snapshot = await createEmergencySnapshot({
      id: "restore_tamper",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot,
      paths: [target],
    });
    const manifest = JSON.parse(await readFile(join(snapshot.path, "manifest.json"), "utf8")) as { records: Array<{ backup?: string }> };
    await writeFile(join(snapshot.path, manifest.records[0]!.backup!), "tampered");
    await writeFile(target, "current must survive");
    await expect(restoreEmergencySnapshot(snapshot.path)).rejects.toThrow("digest");
    expect(await readFile(target, "utf8")).toBe("current must survive");

    await expect(createEmergencySnapshot({
      id: "restore_escape",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot,
      paths: [join(base, "outside.txt")],
    })).rejects.toThrow("outside");
  });

  it("validates snapshot creation boundaries and removes partial snapshots", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-boundaries-"));
    temporary.push(base);
    const targetRoot = join(base, "target");
    const target = join(targetRoot, "value.txt");
    await mkdir(targetRoot);
    await writeFile(target, "value");
    const common = {
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot,
      paths: [target],
    };
    await expect(createEmergencySnapshot({ ...common, id: "../bad" })).rejects.toThrow("ID is invalid");
    await expect(createEmergencySnapshot({ ...common, id: "bad_time", createdAt: "not-a-time" })).rejects.toThrow("timestamp is invalid");
    await expect(createEmergencySnapshot({ ...common, id: "root_path", paths: [targetRoot] })).rejects.toThrow("outside");
    await expect(createEmergencySnapshot({ ...common, id: "nested_home", statecaseHome: join(targetRoot, ".statecase") }))
      .rejects.toThrow("cannot be inside");

    const notDirectory = join(base, "plain-file");
    await writeFile(notDirectory, "plain");
    await expect(createEmergencySnapshot({ ...common, id: "not_directory", targetRoot: notDirectory, paths: [] }))
      .rejects.toThrow("real directory");

    const directoryTarget = join(targetRoot, "directory");
    await mkdir(directoryTarget);
    await expect(createEmergencySnapshot({ ...common, id: "non_regular", paths: [directoryTarget] }))
      .rejects.toThrow("non-regular");
    await expect(lstat(join(common.statecaseHome, "recovery", "non_regular"))).rejects.toMatchObject({ code: "ENOENT" });

    const deduplicated = await createEmergencySnapshot({ ...common, id: "deduplicated", paths: [target, target] });
    expect(deduplicated.records).toBe(1);
    expect(await inspectEmergencySnapshot(deduplicated.path)).toEqual({
      id: "deduplicated",
      targetRoot,
      harness: null,
      records: 1,
    });
  });

  it("rejects malformed manifests and records before touching a target", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-manifests-"));
    temporary.push(base);
    const targetRoot = join(base, "target");
    await mkdir(targetRoot);
    const snapshot = join(base, "snapshot");
    await mkdir(snapshot);
    const manifestPath = join(snapshot, "manifest.json");
    const valid = {
      version: 1,
      id: "valid",
      createdAt: "2026-09-07T18:00:00.000Z",
      targetRoot,
      harness: null,
      records: [],
    };
    const invalidManifests: unknown[] = [
      null,
      [],
      {},
      { ...valid, version: 2 },
      { ...valid, id: 5 },
      { ...valid, createdAt: 5 },
      { ...valid, targetRoot: "relative" },
      { ...valid, records: "no" },
      { ...valid, harness: "other" },
      { ...valid, records: Array.from({ length: 100_001 }, () => ({ path: "x", kind: "absent" })) },
    ];
    for (const value of invalidManifests) {
      await writeFile(manifestPath, JSON.stringify(value));
      await expect(inspectEmergencySnapshot(snapshot)).rejects.toThrow("invalid emergency snapshot manifest");
    }

    const invalidRecords: unknown[] = [
      null,
      [],
      {},
      { path: "", kind: "absent" },
      { path: "../escape", kind: "absent" },
      { path: "bad\\path", kind: "absent" },
      { path: "/absolute", kind: "absent" },
      { path: "x", kind: "symlink", target: "bad\0target" },
      { path: "x", kind: "file", backup: "../escape", digest: "x".repeat(43), size: 0, mode: 0o600 },
      { path: "x", kind: "file", backup: "files/x", digest: "bad", size: 0, mode: 0o600 },
      { path: "x", kind: "file", backup: "files/x", digest: "x".repeat(43), size: -1, mode: 0o600 },
      { path: "x", kind: "file", backup: "files/x", digest: "x".repeat(43), size: 0, mode: 0o1000 },
      { path: "x", kind: "unknown" },
    ];
    for (const record of invalidRecords) {
      await writeFile(manifestPath, JSON.stringify({ ...valid, records: [record] }));
      await expect(restoreEmergencySnapshot(snapshot)).rejects.toThrow("invalid emergency snapshot record");
    }
    await writeFile(manifestPath, JSON.stringify({ ...valid, records: [{ path: "x", kind: "absent" }, { path: "x", kind: "absent" }] }));
    await expect(restoreEmergencySnapshot(snapshot)).rejects.toThrow("invalid emergency snapshot record");
  });

  it("rejects a backup whose type or declared size does not match", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-backup-"));
    temporary.push(base);
    const targetRoot = join(base, "target");
    await mkdir(targetRoot);
    const target = join(targetRoot, "value.txt");
    await writeFile(target, "original");
    const snapshot = await createEmergencySnapshot({
      id: "backup_types",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot,
      paths: [target],
      harness: "codex",
    });
    const manifestPath = join(snapshot.path, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { records: Array<{ backup: string; size: number }> };
    manifest.records[0]!.size += 1;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(restoreEmergencySnapshot(snapshot.path)).rejects.toThrow("digest verification");

    manifest.records[0]!.size -= 1;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const backup = join(snapshot.path, manifest.records[0]!.backup);
    const { rm } = await import("node:fs/promises");
    await rm(backup);
    await mkdir(backup);
    await expect(restoreEmergencySnapshot(snapshot.path)).rejects.toThrow("digest verification");
    expect((await inspectEmergencySnapshot(snapshot.path)).harness).toBe("codex");
  });

  it("restores Git HEAD, mutated refs, raw index, and dirty worktree exactly (BK-009, WS-030)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-git-"));
    temporary.push(base);
    const root = join(base, "workspace");
    await mkdir(root);
    await git(root, "init", "-q");
    await writeFile(join(root, "tracked.txt"), "base\n");
    await git(root, "add", "tracked.txt");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "base");
    await git(root, "branch", "-M", "main");
    const baseCommit = (await git(root, "rev-parse", "HEAD")).trim();
    await git(root, "branch", "historical", baseCommit);
    await writeFile(join(root, "tracked.txt"), "later committed\n");
    await git(root, "add", "tracked.txt");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "later");
    const originalHead = (await git(root, "rev-parse", "HEAD")).trim();
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    await writeFile(join(root, "tracked.txt"), "worktree\n");
    await writeFile(join(root, "untracked.txt"), "untracked\n");
    const originalStatus = await git(root, "status", "--porcelain=v1", "-z");
    const indexPath = (await git(root, "rev-parse", "--git-path", "index")).trim();
    const originalIndex = await readFile(join(root, indexPath));
    const originalIndexMode = (await lstat(join(root, indexPath))).mode & 0o777;

    const snapshot = await createEmergencySnapshot({
      id: "workspace_restore",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot: root,
      paths: [join(root, "tracked.txt"), join(root, "untracked.txt")],
      workspace: { targetHeadRef: "historical" },
    });

    await git(root, "reset", "--hard", "-q", "HEAD");
    await git(root, "update-ref", "refs/heads/historical", originalHead);
    await git(root, "symbolic-ref", "HEAD", "refs/heads/historical");
    await writeFile(join(root, "tracked.txt"), "restored historical state\n");
    await writeFile(join(root, "untracked.txt"), "replacement\n");

    await restoreEmergencySnapshot(snapshot.path);

    expect((await git(root, "symbolic-ref", "--short", "HEAD")).trim()).toBe("main");
    expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(originalHead);
    expect((await git(root, "rev-parse", "historical")).trim()).toBe(baseCommit);
    expect(await readFile(join(root, indexPath))).toEqual(originalIndex);
    expect((await lstat(join(root, indexPath))).mode & 0o777).toBe(originalIndexMode);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("worktree\n");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(await git(root, "status", "--porcelain=v1", "-z")).toBe(originalStatus);
    expect((await inspectEmergencySnapshot(snapshot.path)).workspace).toBe(true);
  });

  it("restores an unborn repository with an absent index and previously absent refs (BK-009, WS-014)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-unborn-"));
    temporary.push(base);
    const root = join(base, "workspace");
    await mkdir(root);
    await git(root, "init", "-q");
    const originalRef = (await git(root, "symbolic-ref", "--short", "HEAD")).trim();
    const future = join(root, "future.txt");
    const snapshot = await createEmergencySnapshot({
      id: "workspace_unborn",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot: root,
      paths: [future],
      workspace: { targetHeadRef: "portable-target" },
    });
    await writeFile(future, "created later\n");
    await git(root, "add", "future.txt");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "temporary");
    await git(root, "branch", "portable-target");

    await restoreEmergencySnapshot(snapshot.path);

    await expect(git(root, "rev-parse", "--verify", "HEAD")).rejects.toBeInstanceOf(Error);
    await expect(git(root, "rev-parse", "--verify", "portable-target")).rejects.toBeInstanceOf(Error);
    expect((await git(root, "symbolic-ref", "--short", "HEAD")).trim()).toBe(originalRef);
    await expect(readFile(future)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, ".git", "index"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores a detached HEAD and refuses a corrupt Git index backup before mutation (BK-009, WS-014)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-detached-"));
    temporary.push(base);
    const root = join(base, "workspace");
    await mkdir(root);
    await git(root, "init", "-q");
    await writeFile(join(root, "tracked.txt"), "base\n");
    await git(root, "add", "tracked.txt");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "base");
    await git(root, "checkout", "--detach", "-q");
    const originalHead = (await git(root, "rev-parse", "HEAD")).trim();
    await writeFile(join(root, "tracked.txt"), "detached dirty\n");
    const snapshot = await createEmergencySnapshot({
      id: "workspace_detached",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot: root,
      paths: [join(root, "tracked.txt")],
      workspace: { targetHeadRef: null },
    });
    await writeFile(join(root, "tracked.txt"), "replacement\n");
    await git(root, "symbolic-ref", "HEAD", "refs/heads/temporary");
    await restoreEmergencySnapshot(snapshot.path);
    await expect(git(root, "symbolic-ref", "--short", "HEAD")).rejects.toBeInstanceOf(Error);
    expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(originalHead);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("detached dirty\n");

    const corrupt = await createEmergencySnapshot({
      id: "workspace_corrupt_index",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot: root,
      paths: [join(root, "tracked.txt")],
      workspace: { targetHeadRef: null },
    });
    await writeFile(join(corrupt.path, "git", "index.bin"), "corrupt");
    await writeFile(join(root, "tracked.txt"), "must survive failed rollback\n");
    await expect(restoreEmergencySnapshot(corrupt.path)).rejects.toThrow("index failed digest verification");
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("must survive failed rollback\n");
  });

  it("rejects invalid workspace snapshot requests and manifests", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-invalid-git-"));
    temporary.push(base);
    const ordinary = join(base, "ordinary");
    await mkdir(ordinary);
    await expect(createEmergencySnapshot({
      id: "not_git",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot: ordinary,
      paths: [],
      workspace: { targetHeadRef: "main" },
    })).rejects.toThrow("Git working tree");

    const root = join(base, "workspace");
    await mkdir(root);
    await git(root, "init", "-q");
    await expect(createEmergencySnapshot({
      id: "bad_ref",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot: root,
      paths: [],
      workspace: { targetHeadRef: "../bad" },
    })).rejects.toThrow("target head reference");

    const snapshot = join(base, "malformed-workspace-snapshot");
    await mkdir(snapshot);
    const baseManifest = {
      version: 1,
      id: "invalid_workspace",
      createdAt: "2026-09-07T18:00:00.000Z",
      targetRoot: root,
      harness: null,
      records: [],
    };
    const invalidStates = [
      null,
      {},
      { headCommit: "bad", headRef: null, index: { kind: "absent" }, refs: [] },
      { headCommit: null, headRef: "main", index: { kind: "absent" }, refs: [] },
      { headCommit: null, headRef: "refs/heads/main", index: { kind: "file", backup: "../index", digest: "x".repeat(43), size: 0 }, refs: [] },
      { headCommit: null, headRef: "refs/heads/main", index: { kind: "other" }, refs: [] },
      { headCommit: null, headRef: "refs/heads/main", index: { kind: "absent" }, refs: [
        { name: "refs/heads/main", target: null, recoveryRef: null },
        { name: "refs/heads/main", target: null, recoveryRef: null },
      ] },
    ];
    for (const workspace of invalidStates) {
      await writeFile(join(snapshot, "manifest.json"), JSON.stringify({ ...baseManifest, workspace }));
      await expect(restoreEmergencySnapshot(snapshot)).rejects.toThrow("invalid emergency workspace state");
    }
    await rm(join(base, "statecase"), { recursive: true, force: true });
  });

  it("detects HEAD, ref, index, and worktree races before publishing recovery metadata (BK-009)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-races-"));
    temporary.push(base);
    const root = join(base, "workspace");
    await mkdir(root);
    await git(root, "init", "-q");
    await writeFile(join(root, "tracked.txt"), "first\n");
    await git(root, "add", "tracked.txt");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "first");
    const first = (await git(root, "rev-parse", "HEAD")).trim();
    await writeFile(join(root, "tracked.txt"), "second\n");
    await git(root, "add", "tracked.txt");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "second");
    const second = (await git(root, "rev-parse", "HEAD")).trim();
    await git(root, "branch", "target", first);
    const statecaseHome = join(base, "statecase");
    const common = {
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome,
      targetRoot: root,
      workspace: { targetHeadRef: "target" },
    };

    await expect(createEmergencySnapshot({
      ...common,
      id: "race_head",
      paths: [join(root, "tracked.txt")],
      beforeFinalize: async () => { await git(root, "update-ref", "refs/heads/master", first); },
    })).rejects.toThrow("workspace changed");
    await git(root, "update-ref", "refs/heads/master", second);

    await expect(createEmergencySnapshot({
      ...common,
      id: "race_ref",
      paths: [join(root, "tracked.txt")],
      beforeFinalize: async () => { await git(root, "update-ref", "refs/heads/target", second); },
    })).rejects.toThrow("workspace ref changed");
    await git(root, "update-ref", "refs/heads/target", first);

    await expect(createEmergencySnapshot({
      ...common,
      id: "race_index",
      paths: [join(root, "tracked.txt")],
      beforeFinalize: async () => {
        await writeFile(join(root, "tracked.txt"), "new index\n");
        await git(root, "add", "tracked.txt");
      },
    })).rejects.toThrow("workspace index changed");
    await git(root, "reset", "--hard", "-q", "HEAD");

    const absent = join(root, "absent.txt");
    await expect(createEmergencySnapshot({
      ...common,
      id: "race_absent",
      paths: [absent],
      beforeFinalize: () => writeFile(absent, "appeared\n"),
    })).rejects.toThrow("source changed while finalizing");
    await rm(absent);

    const linked = join(root, "portable-link");
    await symlink("tracked.txt", linked);
    await expect(createEmergencySnapshot({
      ...common,
      id: "race_symlink",
      paths: [linked],
      beforeFinalize: async () => {
        await rm(linked);
        await symlink("absent.txt", linked);
      },
    })).rejects.toThrow("source changed while finalizing");
    await rm(linked);

    await expect(createEmergencySnapshot({
      ...common,
      id: "race_file",
      paths: [join(root, "tracked.txt")],
      beforeFinalize: () => writeFile(join(root, "tracked.txt"), "changed after copy\n"),
    })).rejects.toThrow("source changed while finalizing");
  });
});

async function git(root: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-C", root, ...args], { encoding: "utf8" })).stdout;
}
