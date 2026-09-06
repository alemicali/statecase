import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyWorkspaceCapsule,
  applyWorkspaceTransaction,
  assertWorkspaceDestination,
  captureWorkspace,
  WorkspaceBaselineUnavailable,
  workspaceMatchesCapsule,
} from "../src/index.js";

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

  it("fetches a missing shallow baseline only under explicit auto policy (WS-015)", async () => {
    const source = await repository("fetch-source");
    const remote = await bareRepository("fetch-remote");
    await git(source, "remote", "add", "origin", `file://${remote}`);
    await git(source, "branch", "-M", "main");
    await git(source, "push", "-u", "origin", "main");
    const baseline = (await git(source, "rev-parse", "HEAD")).trim();

    await writeFile(join(source, "tracked.txt"), "portable uncommitted overlay\n");
    const captured = await captureWorkspace(source);
    const expectedStatus = await git(source, "status", "--porcelain=v1", "-z");
    await git(source, "reset", "--hard", "-q", "HEAD");
    await writeFile(join(source, "tracked.txt"), "new upstream head\n");
    await git(source, "add", "tracked.txt");
    await git(source, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "new head");
    await git(source, "push", "origin", "main");

    const denied = await shallowClone(remote, "fetch-denied");
    const deniedHead = (await git(denied, "rev-parse", "HEAD")).trim();
    const deniedIndex = await readFile(join(denied, ".git", "index"));
    await expect(applyWorkspaceCapsule(denied, captured, { materialize, gitFetch: "ask" }))
      .rejects.toMatchObject({ name: "WorkspaceBaselineUnavailable", code: "BASELINE_UNAVAILABLE", reason: "approval-required" });
    await expect(applyWorkspaceCapsule(denied, captured, { materialize, gitFetch: "never" }))
      .rejects.toMatchObject({ name: "WorkspaceBaselineUnavailable", code: "BASELINE_UNAVAILABLE", reason: "policy-disabled" });
    expect((await git(denied, "rev-parse", "HEAD")).trim()).toBe(deniedHead);
    expect(await readFile(join(denied, ".git", "index"))).toEqual(deniedIndex);
    await expect(git(denied, "cat-file", "-e", `${baseline}^{commit}`)).rejects.toBeInstanceOf(Error);

    const target = await shallowClone(remote, "fetch-auto");
    await applyWorkspaceCapsule(target, captured, { materialize, gitFetch: "auto" });
    expect((await git(target, "rev-parse", "HEAD")).trim()).toBe(baseline);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("portable uncommitted overlay\n");
    expect(await git(target, "status", "--porcelain=v1", "-z")).toBe(expectedStatus);
  });

  it("reports an unreachable baseline without leaking Git errors or partially switching HEAD", async () => {
    const source = await repository("unreachable-source");
    const captured = await captureWorkspace(source);
    const target = await unbornRepository("unreachable-target");
    await writeFile(join(target, "unrelated.txt"), "independent history\n");
    await git(target, "add", "unrelated.txt");
    await git(target, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "independent");
    await git(target, "remote", "add", "origin", "https://credential-do-not-print@example.invalid/private/repo.git");
    const head = (await git(target, "rev-parse", "HEAD")).trim();

    let failure: unknown;
    try {
      await applyWorkspaceCapsule(target, captured, { materialize, gitFetch: "auto" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WorkspaceBaselineUnavailable);
    expect((failure as Error).message).toContain("BASELINE_UNAVAILABLE");
    expect((failure as Error).message).not.toContain("credential-do-not-print");
    expect((await git(target, "rev-parse", "HEAD")).trim()).toBe(head);
    expect(await git(target, "status", "--porcelain=v1")).toBe("");
  });

  it("reports a Git LFS pointer instead of treating absent content as complete (WS-017)", async () => {
    const root = await repository("lfs-pointer");
    await writeFile(join(root, "asset.bin"), lfsPointer("a".repeat(64), 12_345));
    await git(root, "add", "asset.bin");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "LFS pointer");

    const expected = {
      name: "GitLfsContentUnavailable",
      code: "GIT_LFS_CONTENT_UNAVAILABLE",
      paths: ["asset.bin"],
    };
    await expect(captureWorkspace(root)).rejects.toMatchObject(expected);
    await expect(assertWorkspaceDestination(root, {
      capsule: {
        schemaVersion: 1,
        baseCommit: (await git(root, "rev-parse", "HEAD")).trim(),
        headRef: (await git(root, "symbolic-ref", "--short", "HEAD")).trim(),
        records: [],
      },
      blobs: [],
    })).rejects.toMatchObject(expected);
    await expect(assertWorkspaceDestination(root, {
      capsule: {
        schemaVersion: 1,
        baseCommit: (await git(root, "rev-parse", "HEAD")).trim(),
        headRef: (await git(root, "symbolic-ref", "--short", "HEAD")).trim(),
        records: [{ path: "asset.bin", index: { state: "base" }, worktree: { state: "index" } }],
      },
      blobs: [],
    })).rejects.toMatchObject(expected);
  });

  it("allows encrypted overlay bytes to replace a baseline LFS pointer", async () => {
    const source = await repository("lfs-overlay-source");
    await writeFile(join(source, "asset.bin"), lfsPointer("b".repeat(64), 19));
    await git(source, "add", "asset.bin");
    await git(source, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "LFS pointer");
    const targetParent = await mkdtemp(join(tmpdir(), "statecase-workspace-lfs-target-"));
    temporary.push(targetParent);
    const target = join(targetParent, "checkout");
    await run("git", ["clone", "--quiet", source, target]);

    const materialized = `${"materialized content ".repeat(1_000)}\n`;
    await writeFile(join(source, "asset.bin"), materialized);
    const captured = await captureWorkspace(source);
    await expect(applyWorkspaceCapsule(target, captured, { materialize })).resolves.toBeUndefined();
    expect(await readFile(join(target, "asset.bin"), "utf8")).toBe(materialized);
  });

  it("reports a missing LFS worktree file and permits an explicit overlay deletion", async () => {
    const missing = await repository("lfs-missing");
    await writeFile(join(missing, "missing.bin"), lfsPointer("c".repeat(64), 99));
    await git(missing, "add", "missing.bin");
    await git(missing, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "missing LFS pointer");
    await git(missing, "update-index", "--skip-worktree", "missing.bin");
    await rm(join(missing, "missing.bin"));
    await expect(captureWorkspace(missing)).rejects.toMatchObject({
      name: "GitLfsContentUnavailable",
      reason: "missing",
      paths: ["missing.bin"],
    });

    const source = await repository("lfs-deletion-source");
    await writeFile(join(source, "delete.bin"), lfsPointer("d".repeat(64), 100));
    await git(source, "add", "delete.bin");
    await git(source, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "deletable LFS pointer");
    const targetParent = await mkdtemp(join(tmpdir(), "statecase-workspace-lfs-delete-"));
    temporary.push(targetParent);
    const target = join(targetParent, "checkout");
    await run("git", ["clone", "--quiet", source, target]);
    await git(source, "rm", "-q", "delete.bin");
    const captured = await captureWorkspace(source);
    await applyWorkspaceCapsule(target, captured, { materialize });
    await expect(readFile(join(target, "delete.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not mistake malformed or oversized lookalikes for Git LFS pointers", async () => {
    const root = await repository("lfs-lookalikes");
    await writeFile(join(root, "malformed.txt"), "version https://git-lfs.github.com/spec/v1\noid sha256:nope\nsize 12\n");
    await writeFile(join(root, "oversized.txt"), `version https://git-lfs.github.com/spec/v1\n${"x".repeat(17_000)}\n`);
    await writeFile(join(root, "unsafe-size.txt"), `version https://git-lfs.github.com/spec/v1\noid sha256:${"e".repeat(64)}\nsize 999999999999999999999999\n`);
    await writeFile(join(root, "binary.txt"), Buffer.concat([
      Buffer.from("version https://git-lfs.github.com/spec/v1\n"),
      Buffer.from([0xff]),
      Buffer.from(`\noid sha256:${"f".repeat(64)}\nsize 1\n`),
    ]));
    await git(root, "add", "malformed.txt", "oversized.txt", "unsafe-size.txt", "binary.txt");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "pointer lookalikes");
    await expect(captureWorkspace(root)).resolves.toMatchObject({ capsule: { records: [] }, blobs: [] });
  });

  it("accepts already-materialized LFS worktrees and staged replacements", async () => {
    const root = await repository("lfs-materialized");
    await writeFile(join(root, "small.bin"), lfsPointer("1".repeat(64), 3));
    await writeFile(join(root, "large.bin"), lfsPointer("2".repeat(64), 20_000));
    await writeFile(join(root, "staged.bin"), lfsPointer("3".repeat(64), 7));
    await git(root, "add", "small.bin", "large.bin", "staged.bin");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "LFS pointers");
    await git(root, "update-index", "--skip-worktree", "small.bin", "large.bin");
    await writeFile(join(root, "small.bin"), "abc");
    await writeFile(join(root, "large.bin"), "x".repeat(20_000));
    await writeFile(join(root, "staged.bin"), "staged!\n");
    await git(root, "add", "staged.bin");

    const captured = await captureWorkspace(root);
    expect(captured.capsule.records).toContainEqual(expect.objectContaining({
      path: "staged.bin",
      index: expect.objectContaining({ state: "content" }),
      worktree: { state: "index" },
    }));
  });

  it("recognizes a canonical Git LFS pointer without a trailing newline", async () => {
    const root = await repository("lfs-no-newline");
    await writeFile(join(root, "asset.bin"), lfsPointer("4".repeat(64), 8).trimEnd());
    await git(root, "add", "asset.bin");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "LFS pointer without newline");
    await expect(captureWorkspace(root)).rejects.toMatchObject({ name: "GitLfsContentUnavailable", paths: ["asset.bin"] });
  });

  it("redacts and classifies a failing Git LFS checkout filter", async () => {
    const source = await repository("lfs-filter-source");
    await mkdir(join(source, "nested"));
    await writeFile(join(source, "nested", ".gitattributes"), "asset.bin filter=lfs\n");
    await writeFile(join(source, "nested", "asset.bin"), lfsPointer("5".repeat(64), 42));
    await git(source, "config", "filter.lfs.clean", "cat");
    await git(source, "config", "filter.lfs.smudge", "cat");
    await git(source, "config", "filter.lfs.required", "true");
    await git(source, "add", "nested/.gitattributes", "nested/asset.bin");
    await git(source, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "LFS baseline");
    const baseline = (await git(source, "rev-parse", "HEAD")).trim();
    await git(source, "rm", "-q", "nested/.gitattributes", "nested/asset.bin");
    await git(source, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "later baseline");
    const later = (await git(source, "rev-parse", "HEAD")).trim();
    const targetParent = await mkdtemp(join(tmpdir(), "statecase-workspace-lfs-filter-"));
    temporary.push(targetParent);
    const target = join(targetParent, "checkout");
    await run("git", ["clone", "--quiet", source, target]);
    await git(target, "config", "filter.lfs.clean", "cat");
    await git(target, "config", "filter.lfs.smudge", "sh -c 'echo git-lfs injected failure >&2; exit 1'");
    await git(target, "config", "filter.lfs.required", "true");
    await mkdir(join(target, "nested"));
    await writeFile(join(target, "nested", "device-local.txt"), "preserve me\n");
    await writeFile(join(target, ".git", "info", "exclude"), "nested/device-local.txt\n");

    const capsule = {
      capsule: { schemaVersion: 1 as const, baseCommit: baseline, headRef: "master", records: [] },
      blobs: [],
    };
    await expect(applyWorkspaceCapsule(target, capsule, { materialize, gitFetch: "auto" })).rejects.toMatchObject({
      name: "GitLfsContentUnavailable",
      code: "GIT_LFS_CONTENT_UNAVAILABLE",
      reason: "checkout-filter",
      paths: ["nested/asset.bin"],
    });
    expect((await git(target, "rev-parse", "HEAD")).trim()).toBe(later);
    expect(await git(target, "status", "--porcelain=v1")).toBe("");
    expect(await readFile(join(target, "nested", "device-local.txt"), "utf8")).toBe("preserve me\n");
    await expect(lstat(join(target, "nested", ".gitattributes"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an unrelated failing Git filter classified as a baseline checkout failure", async () => {
    const source = await repository("generic-filter-source");
    await writeFile(join(source, ".gitattributes"), "asset.txt filter=broken\n");
    await writeFile(join(source, "asset.txt"), "baseline bytes\n");
    await git(source, "config", "filter.broken.clean", "cat");
    await git(source, "config", "filter.broken.smudge", "cat");
    await git(source, "config", "filter.broken.required", "true");
    await git(source, "add", ".gitattributes", "asset.txt");
    await git(source, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "filtered baseline");
    const baseline = (await git(source, "rev-parse", "HEAD")).trim();
    await git(source, "rm", "-q", ".gitattributes", "asset.txt");
    await git(source, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "later baseline");
    const later = (await git(source, "rev-parse", "HEAD")).trim();
    const targetParent = await mkdtemp(join(tmpdir(), "statecase-workspace-generic-filter-"));
    temporary.push(targetParent);
    const target = join(targetParent, "checkout");
    await run("git", ["clone", "--quiet", source, target]);
    await git(target, "config", "filter.broken.clean", "cat");
    await git(target, "config", "filter.broken.smudge", "sh -c 'echo injected filter failure >&2; exit 1'");
    await git(target, "config", "filter.broken.required", "true");

    await expect(applyWorkspaceCapsule(target, {
      capsule: { schemaVersion: 1, baseCommit: baseline, headRef: "master", records: [] },
      blobs: [],
    }, { materialize, gitFetch: "auto" })).rejects.toMatchObject({
      name: "WorkspaceBaselineUnavailable",
      code: "BASELINE_UNAVAILABLE",
      reason: "checkout-failed",
    });
    expect((await git(target, "rev-parse", "HEAD")).trim()).toBe(later);
    expect(await git(target, "status", "--porcelain=v1")).toBe("");
  });

  it("rolls back an automatic baseline checkout when materialization fails", async () => {
    const source = await repository("checkout-rollback-source");
    const baseline = (await git(source, "rev-parse", "HEAD")).trim();
    await writeFile(join(source, "tracked.txt"), "overlay before failure\n");
    const captured = await captureWorkspace(source);
    await git(source, "reset", "--hard", "-q", "HEAD");
    await writeFile(join(source, "tracked.txt"), "later head\n");
    await git(source, "add", "tracked.txt");
    await git(source, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "later");
    const later = (await git(source, "rev-parse", "HEAD")).trim();
    expect(later).not.toBe(baseline);
    await git(source, "checkout", "--detach", "-q");

    await expect(applyWorkspaceCapsule(source, captured, {
      gitFetch: "auto",
      materialize: async () => { throw new Error("injected materialization failure"); },
    })).rejects.toThrow("injected materialization failure");
    expect((await git(source, "rev-parse", "HEAD")).trim()).toBe(later);
    expect(await git(source, "status", "--porcelain=v1")).toBe("");
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("later head\n");
  });

  it("rolls back earlier baseline checkouts when a later workspace cannot fetch", async () => {
    const first = await repository("multi-fetch-first");
    const firstBaseline = (await git(first, "rev-parse", "HEAD")).trim();
    await writeFile(join(first, "tracked.txt"), "first overlay\n");
    const firstCaptured = await captureWorkspace(first);
    await git(first, "reset", "--hard", "-q", "HEAD");
    await writeFile(join(first, "tracked.txt"), "first later head\n");
    await git(first, "add", "tracked.txt");
    await git(first, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "later");
    const firstLater = (await git(first, "rev-parse", "HEAD")).trim();
    expect(firstLater).not.toBe(firstBaseline);

    const secondSource = await repository("multi-fetch-second-source");
    await writeFile(join(secondSource, "tracked.txt"), "second overlay\n");
    const secondCaptured = await captureWorkspace(secondSource);
    const secondTarget = await unbornRepository("multi-fetch-second-target");
    await writeFile(join(secondTarget, "unrelated.txt"), "independent history\n");
    await git(secondTarget, "add", "unrelated.txt");
    await git(secondTarget, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "independent");
    await git(secondTarget, "remote", "add", "origin", "https://unreachable.invalid/statecase/test.git");
    const secondHead = (await git(secondTarget, "rev-parse", "HEAD")).trim();
    let materializations = 0;

    await expect(applyWorkspaceTransaction(
      [
        { root: first, captured: firstCaptured, gitFetch: "auto" },
        { root: secondTarget, captured: secondCaptured, gitFetch: "auto" },
      ],
      { writes: [], deletes: [] },
      { materialize: async () => { materializations += 1; } },
    )).rejects.toMatchObject({ name: "WorkspaceBaselineUnavailable", code: "BASELINE_UNAVAILABLE" });

    expect(materializations).toBe(0);
    expect((await git(first, "rev-parse", "HEAD")).trim()).toBe(firstLater);
    expect(await git(first, "status", "--porcelain=v1")).toBe("");
    expect(await readFile(join(first, "tracked.txt"), "utf8")).toBe("first later head\n");
    expect((await git(secondTarget, "rev-parse", "HEAD")).trim()).toBe(secondHead);
    expect(await git(secondTarget, "status", "--porcelain=v1")).toBe("");
  });

  it("restores an unborn destination when apply fails after automatic acquisition", async () => {
    const source = await repository("unborn-acquisition-source");
    await writeFile(join(source, "tracked.txt"), "overlay destined to fail\n");
    const captured = await captureWorkspace(source);
    const target = await unbornRepository("unborn-acquisition-target");
    await git(target, "remote", "add", "origin", source);
    const originalRef = (await git(target, "symbolic-ref", "--short", "HEAD")).trim();

    await expect(applyWorkspaceCapsule(target, captured, {
      gitFetch: "auto",
      materialize: async () => { throw new Error("injected unborn failure"); },
    })).rejects.toThrow("injected unborn failure");

    await expect(git(target, "rev-parse", "--verify", "HEAD")).rejects.toBeInstanceOf(Error);
    expect((await git(target, "symbolic-ref", "--short", "HEAD")).trim()).toBe(originalRef);
    expect(await git(target, "status", "--porcelain=v1")).toBe("");
    await expect(readFile(join(target, "tracked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
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

async function bareRepository(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `statecase-workspace-${name}-`));
  temporary.push(root);
  await git(root, "init", "--bare", "-q");
  return root;
}

async function shallowClone(remote: string, name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), `statecase-workspace-${name}-`));
  temporary.push(parent);
  const root = join(parent, "checkout");
  await run("git", ["clone", "--quiet", "--depth", "1", "--branch", "main", `file://${remote}`, root]);
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

function lfsPointer(oid: string, size: number): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
}
