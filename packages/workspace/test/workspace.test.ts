import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyWorkspaceCapsule,
  applyWorkspaceTransaction,
  assertWorkspaceAdvance,
  assertWorkspaceDestination,
  assertWorkspaceReplacement,
  captureWorkspace,
  replaceWorkspaceCapsule,
  WorkspaceBaselineUnavailable,
  workspaceMatchesCapsule,
  type WorkspaceFileTransaction,
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

  it("materializes a staged-only change when the worktree exactly matches the index", async () => {
    const source = await repository("staged-only-source");
    const target = await repository("staged-only-target");
    await writeFile(join(source, "tracked.txt"), "staged and worktree\n");
    await git(source, "add", "tracked.txt");
    const captured = await captureWorkspace(source);
    expect(captured.capsule.records[0]?.worktree.state).toBe("index");

    await applyWorkspaceCapsule(target, captured, { materialize });

    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("staged and worktree\n");
    expect(await git(target, "show", ":tracked.txt")).toBe("staged and worktree\n");
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
    expect((await git(target, "symbolic-ref", "--short", "HEAD")).trim()).toBe("main");
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("portable uncommitted overlay\n");
    expect(await git(target, "status", "--porcelain=v1", "-z")).toBe(expectedStatus);

    const rollbackTarget = await shallowClone(remote, "fetch-auto-rollback");
    const rollbackHead = (await git(rollbackTarget, "rev-parse", "HEAD")).trim();
    await expect(applyWorkspaceCapsule(rollbackTarget, captured, {
      materialize: async () => { throw new Error("injected post-identity failure"); },
      gitFetch: "auto",
    })).rejects.toThrow("injected post-identity failure");
    expect((await git(rollbackTarget, "rev-parse", "HEAD")).trim()).toBe(rollbackHead);
    expect((await git(rollbackTarget, "rev-parse", "refs/heads/main")).trim()).toBe(rollbackHead);
    expect((await git(rollbackTarget, "symbolic-ref", "--short", "HEAD")).trim()).toBe("main");
    expect(await git(rollbackTarget, "status", "--porcelain=v1")).toBe("");
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
    const baselineCapsule = {
      capsule: {
        schemaVersion: 1 as const,
        baseCommit: (await git(root, "rev-parse", "HEAD")).trim(),
        headRef: (await git(root, "symbolic-ref", "--short", "HEAD")).trim(),
        records: [],
      },
      blobs: [],
    };
    await expect(captureWorkspace(root)).rejects.toMatchObject(expected);
    await expect(assertWorkspaceDestination(root, baselineCapsule)).rejects.toMatchObject(expected);
    await expect(assertWorkspaceReplacement(root, baselineCapsule)).rejects.toMatchObject(expected);
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

  it("materializes Git LFS through explicit auto policy and verifies downloaded bytes", async () => {
    const root = await repository("lfs-auto");
    const remote = await bareRepository("lfs-auto-remote");
    const actual = Buffer.from("device-local Git LFS content\n");
    const oid = createHash("sha256").update(actual).digest("hex");
    const pointer = lfsPointer(oid, actual.byteLength);
    await writeFile(join(root, ".gitattributes"), "asset.bin filter=lfs diff=lfs merge=lfs -text\n");
    await writeFile(join(root, "asset.bin"), pointer);
    await git(root, "add", ".gitattributes", "asset.bin");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "LFS baseline");
    await git(root, "remote", "add", "origin", `file://${remote}`);
    await git(root, "update-index", "--skip-worktree", "asset.bin");
    const fixture = await fakeGitLfs(actual);

    await withEnvironment(fixture.environment, async () => {
      const probe = await run("git", ["-C", root, "lfs", "version"], { encoding: "utf8", env: process.env });
      expect(probe.stdout).toContain("git-lfs/3.7.1 (fixture)");
      const beforeAskLog = await readFile(fixture.log, "utf8");
      await expect(captureWorkspace(root, { gitFetch: "ask" })).rejects.toMatchObject({
        name: "GitLfsContentUnavailable",
        reason: "pointer",
      });
      expect(await readFile(fixture.log, "utf8")).toBe(beforeAskLog);

      const captured = await captureWorkspace(root, { gitFetch: "auto" });
      expect(captured).toMatchObject({ capsule: { records: [] }, blobs: [] });
      expect(await readFile(join(root, "asset.bin"))).toEqual(actual);
      const commands = await readFile(fixture.log, "utf8");
      expect(commands).toContain("version");
      expect(commands).toContain(`fetch --include= --exclude= origin ${(await git(root, "rev-parse", "HEAD")).trim()}`);
      expect(commands).toContain("checkout");
    });
  });

  it("redacts Git LFS failures and restores the original pointer after corrupt checkout", async () => {
    const root = await repository("lfs-auto-failure");
    const expected = Buffer.from("expected LFS bytes\n");
    const pointer = lfsPointer(createHash("sha256").update(expected).digest("hex"), expected.byteLength);
    await writeFile(join(root, ".gitattributes"), "asset.bin filter=lfs diff=lfs merge=lfs -text\n");
    await writeFile(join(root, "asset.bin"), pointer);
    await git(root, "add", ".gitattributes", "asset.bin");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "LFS baseline");
    await git(root, "remote", "add", "origin", "file:///does-not-matter-to-fixture");
    await git(root, "update-index", "--skip-worktree", "asset.bin");
    const corrupt = await fakeGitLfs(Buffer.from("corrupt bytes\n"));

    await withEnvironment(corrupt.environment, async () => {
      await expect(captureWorkspace(root, { gitFetch: "auto" })).rejects.toMatchObject({
        name: "GitLfsContentUnavailable",
        reason: "integrity",
        paths: ["asset.bin"],
      });
      expect(await readFile(join(root, "asset.bin"), "utf8")).toBe(pointer);
    });

    await writeFile(corrupt.failFetch, "1");
    await withEnvironment(corrupt.environment, async () => {
      const error = await captureWorkspace(root, { gitFetch: "auto" }).catch((failure: unknown) => failure) as Error & { reason: string };
      expect(error).toMatchObject({ name: "GitLfsContentUnavailable", reason: "download-failed" });
      expect(error.message).not.toContain("fixture-secret");
      expect(await readFile(join(root, "asset.bin"), "utf8")).toBe(pointer);
    });
  });

  it("rolls back same-baseline Git LFS materialization when the workspace transaction fails", async () => {
    const root = await repository("lfs-transaction-rollback");
    const actual = Buffer.from("transactional LFS bytes\n");
    const pointer = lfsPointer(createHash("sha256").update(actual).digest("hex"), actual.byteLength);
    await writeFile(join(root, ".gitattributes"), "asset.bin filter=lfs diff=lfs merge=lfs -text\n");
    await writeFile(join(root, "asset.bin"), pointer);
    await git(root, "add", ".gitattributes", "asset.bin");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "LFS baseline");
    await git(root, "remote", "add", "origin", "file:///does-not-matter-to-fixture");
    await git(root, "update-index", "--skip-worktree", "asset.bin");
    const fixture = await fakeGitLfs(actual);
    const captured = {
      capsule: {
        schemaVersion: 1 as const,
        baseCommit: (await git(root, "rev-parse", "HEAD")).trim(),
        headRef: (await git(root, "symbolic-ref", "--short", "HEAD")).trim(),
        records: [],
      },
      blobs: [],
    };

    await withEnvironment(fixture.environment, async () => {
      await expect(applyWorkspaceCapsule(root, captured, {
        gitFetch: "auto",
        materialize: async () => { throw new Error("injected post-LFS failure"); },
      })).rejects.toThrow("injected post-LFS failure");
    });
    expect(await readFile(join(root, "asset.bin"), "utf8")).toBe(pointer);
  });

  it("uses the device-local Git LFS cache before requiring an origin", async () => {
    const root = await repository("lfs-local-cache");
    const actual = Buffer.from("cached LFS bytes\n");
    const pointer = lfsPointer(createHash("sha256").update(actual).digest("hex"), actual.byteLength);
    await writeFile(join(root, "asset.bin"), pointer);
    await git(root, "add", "asset.bin");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "LFS baseline");
    await git(root, "update-index", "--skip-worktree", "asset.bin");
    const fixture = await fakeGitLfs(actual);
    await writeFile(fixture.fetched, "cached");

    await withEnvironment(fixture.environment, async () => {
      await expect(captureWorkspace(root, { gitFetch: "auto" })).resolves.toMatchObject({ capsule: { records: [] } });
    });
    expect(await readFile(join(root, "asset.bin"))).toEqual(actual);
    expect(await readFile(fixture.log, "utf8")).not.toContain("fetch");

    await writeFile(join(root, "asset.bin"), pointer);
    await rm(fixture.fetched);
    await withEnvironment(fixture.environment, async () => {
      await expect(captureWorkspace(root, { gitFetch: "auto" })).rejects.toMatchObject({
        name: "GitLfsContentUnavailable",
        reason: "no-origin",
      });
    });
    expect(await readFile(join(root, "asset.bin"), "utf8")).toBe(pointer);
  });

  it("classifies missing Git LFS tooling and checkout failures without leaking output", async () => {
    const unavailable = await lfsPointerRepository("lfs-binary-missing", Buffer.from("binary fixture\n"));
    const missingBinary = await fakeGitLfs(unavailable.content);
    await writeFile(missingBinary.failVersion, "1");
    await withEnvironment(missingBinary.environment, async () => {
      await expect(captureWorkspace(unavailable.root, { gitFetch: "auto" })).rejects.toMatchObject({
        name: "GitLfsContentUnavailable",
        reason: "binary-missing",
      });
    });
    expect(await readFile(join(unavailable.root, "asset.bin"), "utf8")).toBe(unavailable.pointer);

    const failed = await lfsPointerRepository("lfs-checkout-failure", Buffer.from("checkout fixture\n"));
    const failedCheckout = await fakeGitLfs(failed.content);
    await writeFile(failedCheckout.failCheckout, "1");
    await withEnvironment(failedCheckout.environment, async () => {
      await expect(captureWorkspace(failed.root, { gitFetch: "auto" })).rejects.toMatchObject({
        name: "GitLfsContentUnavailable",
        reason: "download-failed",
      });
    });
    expect(await readFile(join(failed.root, "asset.bin"), "utf8")).toBe(failed.pointer);

    const omitted = await lfsPointerRepository("lfs-checkout-omitted", Buffer.from("omitted fixture\n"));
    const successfulNoop = await fakeGitLfs(omitted.content);
    await writeFile(successfulNoop.suppressMaterialization, "1");
    await withEnvironment(successfulNoop.environment, async () => {
      await expect(captureWorkspace(omitted.root, { gitFetch: "auto" })).rejects.toMatchObject({
        name: "GitLfsContentUnavailable",
        reason: "download-failed",
      });
    });
    expect(await readFile(join(omitted.root, "asset.bin"), "utf8")).toBe(omitted.pointer);
  });

  it("restores an originally missing LFS path when remote acquisition fails", async () => {
    const missing = await lfsPointerRepository("lfs-missing-rollback", Buffer.from("missing fixture\n"));
    await rm(join(missing.root, "asset.bin"));
    const failedFetch = await fakeGitLfs(missing.content);
    await writeFile(failedFetch.failFetch, "1");
    await withEnvironment(failedFetch.environment, async () => {
      await expect(captureWorkspace(missing.root, { gitFetch: "auto" })).rejects.toMatchObject({
        name: "GitLfsContentUnavailable",
        reason: "download-failed",
      });
    });
    await expect(lstat(join(missing.root, "asset.bin"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("applies detached workspace identity and restores a symbolic target after failure (WS-014, WS-015)", async () => {
    const source = await repository("apply-detached-source");
    await git(source, "checkout", "--detach", "-q");
    await writeFile(join(source, "tracked.txt"), "detached overlay\n");
    const captured = await captureWorkspace(source);
    expect(captured.capsule.headRef).toBeNull();

    const parent = await mkdtemp(join(tmpdir(), "statecase-workspace-apply-detached-"));
    temporary.push(parent);
    const target = join(parent, "target");
    const rollbackTarget = join(parent, "rollback-target");
    await run("git", ["clone", "--quiet", source, target]);
    await run("git", ["clone", "--quiet", source, rollbackTarget]);

    await applyWorkspaceCapsule(target, captured, { materialize });
    await expect(git(target, "symbolic-ref", "--short", "HEAD")).rejects.toBeInstanceOf(Error);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("detached overlay\n");

    const originalHead = (await git(rollbackTarget, "rev-parse", "HEAD")).trim();
    const originalRef = (await git(rollbackTarget, "symbolic-ref", "--short", "HEAD")).trim();
    await expect(applyWorkspaceCapsule(rollbackTarget, captured, {
      materialize: async () => { throw new Error("injected detached identity failure"); },
    })).rejects.toThrow("injected detached identity failure");
    expect((await git(rollbackTarget, "rev-parse", "HEAD")).trim()).toBe(originalHead);
    expect((await git(rollbackTarget, "symbolic-ref", "--short", "HEAD")).trim()).toBe(originalRef);
    expect(await git(rollbackTarget, "status", "--porcelain=v1")).toBe("");
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

  it("replaces a dirty workspace with an exact historical branch, index, and worktree (WS-030)", async () => {
    const root = await repository("replace-history");
    await git(root, "branch", "-M", "main");
    const historicalCommit = (await git(root, "rev-parse", "HEAD")).trim();
    await writeFile(join(root, "tracked.txt"), "historical index\n");
    await git(root, "add", "tracked.txt");
    await writeFile(join(root, "tracked.txt"), "historical worktree\n");
    await writeFile(join(root, "historical-only.txt"), "portable untracked\n");
    const historical = await captureWorkspace(root);
    const historicalStatus = await git(root, "status", "--porcelain=v1", "-z");

    await git(root, "reset", "--hard", "-q", "HEAD");
    await writeFile(join(root, "tracked.txt"), "later committed\n");
    await git(root, "add", "tracked.txt");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "later");
    await writeFile(join(root, "tracked.txt"), "current dirty\n");
    await writeFile(join(root, "current-only.txt"), "remove on replacement\n");
    const laterCommit = (await git(root, "rev-parse", "HEAD")).trim();
    let prepared = false;

    await replaceWorkspaceCapsule(root, historical, {
      gitFetch: "auto",
      materialize,
      beforeMutation: async ({ paths, targetHeadRef }) => {
        expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(laterCommit);
        expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("current dirty\n");
        expect(paths).toEqual(expect.arrayContaining([
          join(root, "tracked.txt"),
          join(root, "current-only.txt"),
          join(root, "historical-only.txt"),
        ]));
        expect(targetHeadRef).toBe("main");
        prepared = true;
      },
    });

    expect(prepared).toBe(true);
    expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(historicalCommit);
    expect((await git(root, "symbolic-ref", "--short", "HEAD")).trim()).toBe("main");
    expect(await git(root, "show", ":tracked.txt")).toBe("historical index\n");
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("historical worktree\n");
    expect(await readFile(join(root, "historical-only.txt"), "utf8")).toBe("portable untracked\n");
    await expect(readFile(join(root, "current-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(root, "status", "--porcelain=v1", "-z")).toBe(historicalStatus);
    expect(await workspaceMatchesCapsule(root, historical)).toBe(true);
  });

  it("preflights replacement before mutation and refuses initialized submodules (WS-018, WS-030)", async () => {
    const root = await repository("replace-preflight");
    await writeFile(join(root, "tracked.txt"), "historical\n");
    const historical = await captureWorkspace(root);
    await writeFile(join(root, "tracked.txt"), "must survive\n");
    let prepared = false;
    await expect(replaceWorkspaceCapsule(root, historical, {
      materialize,
      beforeMutation: async () => {
        prepared = true;
        throw new Error("recovery storage unavailable");
      },
    })).rejects.toThrow("recovery storage unavailable");
    expect(prepared).toBe(true);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("must survive\n");

    await git(root, "reset", "--hard", "-q", "HEAD");
    const oid = (await git(root, "rev-parse", "HEAD")).trim();
    await git(root, "update-index", "--add", "--cacheinfo", "160000", oid, "module");
    await mkdir(join(root, "module"));
    prepared = false;
    await expect(replaceWorkspaceCapsule(root, historical, {
      materialize,
      beforeMutation: async () => { prepared = true; },
    })).rejects.toThrow("initialized submodule worktrees are not supported");
    expect(prepared).toBe(false);
  });

  it("replaces committed work with detached and unborn capsule identities (WS-014, WS-030)", async () => {
    const detached = await repository("replace-detached");
    await git(detached, "checkout", "--detach", "-q");
    await writeFile(join(detached, "tracked.txt"), "detached overlay\n");
    const detachedCapsule = await captureWorkspace(detached);
    await git(detached, "checkout", "-q", "master");
    await writeFile(join(detached, "tracked.txt"), "dirty branch\n");
    await replaceWorkspaceCapsule(detached, detachedCapsule, { materialize, beforeMutation: async () => undefined });
    await expect(git(detached, "symbolic-ref", "--short", "HEAD")).rejects.toBeInstanceOf(Error);
    expect(await readFile(join(detached, "tracked.txt"), "utf8")).toBe("detached overlay\n");
    expect(await workspaceMatchesCapsule(detached, detachedCapsule)).toBe(true);

    const unbornSource = await unbornRepository("replace-unborn-source");
    await git(unbornSource, "symbolic-ref", "HEAD", "refs/heads/portable-unborn");
    await writeFile(join(unbornSource, "staged.txt"), "staged unborn\n");
    await git(unbornSource, "add", "staged.txt");
    await writeFile(join(unbornSource, "staged.txt"), "worktree unborn\n");
    const unbornCapsule = await captureWorkspace(unbornSource);
    const committed = await repository("replace-unborn-target");
    await writeFile(join(committed, "current.txt"), "remove me\n");
    await replaceWorkspaceCapsule(committed, unbornCapsule, { materialize, beforeMutation: async () => undefined });
    await expect(git(committed, "rev-parse", "--verify", "HEAD")).rejects.toBeInstanceOf(Error);
    expect((await git(committed, "symbolic-ref", "--short", "HEAD")).trim()).toBe("portable-unborn");
    expect(await git(committed, "show", ":staged.txt")).toBe("staged unborn\n");
    expect(await readFile(join(committed, "staged.txt"), "utf8")).toBe("worktree unborn\n");
    await expect(readFile(join(committed, "current.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await workspaceMatchesCapsule(committed, unbornCapsule)).toBe(true);
  });

  it("applies replacement fetch policy without mutating the checkout before approval (WS-015, WS-030)", async () => {
    const source = await repository("replace-fetch-source");
    await writeFile(join(source, "source-only.txt"), "unique baseline\n");
    await git(source, "add", "source-only.txt");
    await git(source, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "unique source baseline");
    await writeFile(join(source, "tracked.txt"), "fetched overlay\n");
    const captured = await captureWorkspace(source);
    const target = await repository("replace-fetch-target");
    await writeFile(join(target, "tracked.txt"), "independent baseline\n");
    await git(target, "add", "tracked.txt");
    await git(target, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "independent");
    const targetHead = (await git(target, "rev-parse", "HEAD")).trim();

    await expect(assertWorkspaceReplacement(target, captured)).rejects.toMatchObject({ reason: "approval-required" });
    await expect(assertWorkspaceReplacement(target, captured, { gitFetch: "never" })).rejects.toMatchObject({ reason: "policy-disabled" });
    await expect(assertWorkspaceReplacement(target, captured, { gitFetch: "auto" })).rejects.toMatchObject({ reason: "no-origin" });
    expect((await git(target, "rev-parse", "HEAD")).trim()).toBe(targetHead);

    await git(target, "remote", "add", "origin", source);
    let prepared = false;
    await replaceWorkspaceCapsule(target, captured, {
      gitFetch: "auto",
      materialize,
      beforeMutation: async () => { prepared = true; },
    });
    expect(prepared).toBe(true);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("fetched overlay\n");
    expect(await workspaceMatchesCapsule(target, captured)).toBe(true);
  });

  it("rejects invalid branch identity and directory or special-file replacement targets before mutation (WS-001, WS-030)", async () => {
    const source = await repository("replace-target-types-source");
    await writeFile(join(source, "blocked"), "remote\n");
    const captured = await captureWorkspace(source);
    const invalidRef = structuredClone(captured);
    invalidRef.capsule.headRef = "refs/heads/not-a-short-name";
    await expect(assertWorkspaceReplacement(source, invalidRef)).rejects.toThrow("head reference");

    const directoryTarget = await repository("replace-directory-target");
    await mkdir(join(directoryTarget, "blocked"));
    let prepared = false;
    await expect(replaceWorkspaceCapsule(directoryTarget, captured, {
      materialize,
      beforeMutation: async () => { prepared = true; },
    })).rejects.toThrow("directory target");
    expect(prepared).toBe(false);

    if (process.platform !== "win32") {
      await rm(join(directoryTarget, "blocked"), { recursive: true });
      await run("mkfifo", [join(directoryTarget, "blocked")]);
      await expect(replaceWorkspaceCapsule(directoryTarget, captured, {
        materialize,
        beforeMutation: async () => { prepared = true; },
      })).rejects.toThrow("unsupported workspace entry");
      expect(prepared).toBe(false);
    }
  });

  it("replaces worktree deletions, staged-only files, and safe symlinks through every overlay layer (WS-013, WS-030)", async () => {
    const root = await repository("replace-overlay-layers");
    await git(root, "rm", "-q", "deleted.txt");
    await writeFile(join(root, "staged-only.txt"), "staged only\n");
    await git(root, "add", "staged-only.txt");
    await mkdir(join(root, "links"));
    await writeFile(join(root, "links", "target.txt"), "target\n");
    await symlink("target.txt", join(root, "links", "portable"));
    const captured = await captureWorkspace(root);
    await git(root, "reset", "--hard", "-q", "HEAD");
    await writeFile(join(root, "staged-only.txt"), "local replacement\n");

    await replaceWorkspaceCapsule(root, captured, { materialize, beforeMutation: async () => undefined });

    await expect(readFile(join(root, "deleted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(root, "show", ":staged-only.txt")).toBe("staged only\n");
    expect(await readFile(join(root, "staged-only.txt"), "utf8")).toBe("staged only\n");
    expect(await readlink(join(root, "links", "portable"))).toBe("target.txt");
    expect(await workspaceMatchesCapsule(root, captured)).toBe(true);
  });

  it("hydrates a committed replacement into an unborn destination (WS-014, WS-015, WS-030)", async () => {
    const source = await repository("replace-into-unborn-source");
    await writeFile(join(source, "unique.txt"), "committed source\n");
    await git(source, "add", "unique.txt");
    await git(source, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "unique baseline");
    await writeFile(join(source, "tracked.txt"), "portable overlay\n");
    const captured = await captureWorkspace(source);
    const target = await unbornRepository("replace-into-unborn-target");
    await git(target, "remote", "add", "origin", source);

    await replaceWorkspaceCapsule(target, captured, {
      gitFetch: "auto",
      materialize,
      beforeMutation: async ({ paths }) => {
        expect(paths).toContain(join(target, "unique.txt"));
      },
    });

    expect(await readFile(join(target, "unique.txt"), "utf8")).toBe("committed source\n");
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("portable overlay\n");
    expect(await workspaceMatchesCapsule(target, captured)).toBe(true);
  });

  it("validates replacement-only capsule, repository, and gitlink boundaries (WS-001, WS-018, WS-030)", async () => {
    const source = await repository("replace-validation-source");
    await writeFile(join(source, "tracked.txt"), "overlay\n");
    const captured = await captureWorkspace(source);
    const ordinary = await mkdtemp(join(tmpdir(), "statecase-workspace-replace-ordinary-"));
    temporary.push(ordinary);
    await expect(assertWorkspaceReplacement(ordinary, captured)).rejects.toThrow("not a Git working tree");

    const corrupt = structuredClone(captured);
    corrupt.blobs[0]!.bytes[0] ^= 0xff;
    await expect(assertWorkspaceReplacement(source, corrupt)).rejects.toThrow("blob digest does not match");

    const unborn = await unbornRepository("replace-invalid-unborn");
    await writeFile(join(unborn, "new.txt"), "new\n");
    const invalidUnborn = await captureWorkspace(unborn);
    invalidUnborn.capsule.headRef = null;
    await expect(assertWorkspaceReplacement(unborn, invalidUnborn)).rejects.toThrow("unborn workspace requires");

    const gitlinkSource = await repository("replace-gitlink-source");
    const oid = (await git(gitlinkSource, "rev-parse", "HEAD")).trim();
    await git(gitlinkSource, "update-index", "--add", "--cacheinfo", "160000", oid, "module");
    const gitlinkCapsule = await captureWorkspace(gitlinkSource);
    const gitlinkTarget = await repository("replace-gitlink-target");
    await replaceWorkspaceCapsule(gitlinkTarget, gitlinkCapsule, { materialize, beforeMutation: async () => undefined });
    expect(await git(gitlinkTarget, "ls-files", "--stage", "module")).toContain(`160000 ${oid}`);

    await git(gitlinkSource, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "gitlink baseline");
    const cleanGitlinkCapsule = await captureWorkspace(gitlinkSource);
    await mkdir(join(gitlinkSource, "module"));
    await expect(assertWorkspaceReplacement(gitlinkSource, cleanGitlinkCapsule)).rejects.toThrow("initialized submodule");

    const worktreeSource = await repository("replace-linked-worktree-source");
    await git(worktreeSource, "branch", "historical");
    await git(worktreeSource, "checkout", "-q", "historical");
    const historicalBranch = await captureWorkspace(worktreeSource);
    await git(worktreeSource, "checkout", "-q", "master");
    const linkedParent = await mkdtemp(join(tmpdir(), "statecase-linked-worktree-"));
    temporary.push(linkedParent);
    await git(worktreeSource, "worktree", "add", "-q", join(linkedParent, "checkout"), "historical");
    await expect(assertWorkspaceReplacement(worktreeSource, historicalBranch)).rejects.toThrow("checked out in another worktree");
  });
});

describe("authenticated managed workspace advancement (WS-034)", () => {
  it("advances staged/worktree state and restores paths removed from the overlay", async () => {
    const source = await repository("advance-source");
    const target = await repository("advance-target");
    await writeFile(join(source, "tracked.txt"), "old staged\n");
    await git(source, "add", "tracked.txt");
    await writeFile(join(source, "tracked.txt"), "old worktree\n");
    await writeFile(join(source, "temporary.txt"), "old untracked\n");
    await git(source, "rm", "deleted.txt");
    const previous = await captureWorkspace(source);
    await applyWorkspaceCapsule(target, previous, { materialize });
    await git(source, "restore", "--source=HEAD", "--staged", "--worktree", "tracked.txt", "deleted.txt");
    await rm(join(source, "temporary.txt"));
    await writeFile(join(source, "new.txt"), "new staged\n");
    await git(source, "add", "new.txt");
    await writeFile(join(source, "new.txt"), "new worktree\n");
    const next = await captureWorkspace(source);
    await applyWorkspaceTransaction([{ root: target, captured: next, expectedCurrent: previous }], { writes: [], deletes: [] }, { materialize });
    expect(await workspaceMatchesCapsule(target, next)).toBe(true);
    expect(await readFile(join(target, "deleted.txt"), "utf8")).toBe("baseline deleted\n");
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("baseline tracked\n");
    await expect(readFile(join(target, "temporary.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a changed local overlay before calling the materializer", async () => {
    const root = await repository("advance-local-edit");
    const next = await captureWorkspace(root);
    await writeFile(join(root, "tracked.txt"), "last applied\n");
    const previous = await captureWorkspace(root);
    await writeFile(join(root, "tracked.txt"), "new local work\n");
    const index = await readFile(join(root, ".git", "index"));
    let called = false;
    await expect(applyWorkspaceTransaction([{ root, captured: next, expectedCurrent: previous }], { writes: [], deletes: [] }, {
      materialize: async () => { called = true; },
    })).rejects.toThrow("changed since its applied capsule");
    expect(called).toBe(false);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("new local work\n");
    expect(await readFile(join(root, ".git", "index"))).toEqual(index);
  });

  it("honors baseline approval and rolls HEAD/ref back when materialization fails", async () => {
    const root = await repository("advance-baseline");
    const oldCommit = (await git(root, "rev-parse", "HEAD")).trim();
    const oldRef = (await git(root, "symbolic-ref", "--short", "HEAD")).trim();
    await writeFile(join(root, "tracked.txt"), "committed on peer\n");
    await git(root, "add", "tracked.txt");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "next baseline");
    await git(root, "checkout", "-qb", "peer");
    const next = await captureWorkspace(root);
    await git(root, "checkout", "-q", "--detach", oldCommit);
    await writeFile(join(root, "tracked.txt"), "last applied overlay\n");
    const previous = await captureWorkspace(root);
    const index = await readFile(join(root, ".git", "index"));
    await expect(assertWorkspaceAdvance(root, next, previous, "ask")).rejects.toMatchObject({ reason: "approval-required" });
    await expect(assertWorkspaceAdvance(root, next, previous, "never")).rejects.toMatchObject({ reason: "policy-disabled" });
    await expect(applyWorkspaceTransaction([{ root, captured: next, expectedCurrent: previous, gitFetch: "auto" }], { writes: [], deletes: [] }, {
      materialize: async () => { throw new Error("injected materializer failure"); },
    })).rejects.toThrow("injected materializer failure");
    expect(await workspaceMatchesCapsule(root, previous)).toBe(true);
    expect(await readFile(join(root, ".git", "index"))).toEqual(index);
    expect((await git(root, "rev-parse", "peer")).trim()).toBe(next.capsule.baseCommit);
    expect((await git(root, "rev-parse", oldRef)).trim()).toBe(next.capsule.baseCommit);
    await applyWorkspaceTransaction([{ root, captured: next, expectedCurrent: previous, gitFetch: "auto" }], { writes: [], deletes: [] }, { materialize });
    expect(await workspaceMatchesCapsule(root, next)).toBe(true);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("committed on peer\n");
  });

  it("does not steal another Git writer's index lock", async () => {
    const root = await repository("advance-index-lock");
    const next = await captureWorkspace(root);
    await writeFile(join(root, "tracked.txt"), "last applied\n");
    const previous = await captureWorkspace(root);
    const index = await readFile(join(root, ".git", "index"));
    await writeFile(join(root, ".git", "index.lock"), "owned by another writer");
    await expect(applyWorkspaceTransaction([{ root, captured: next, expectedCurrent: previous }], { writes: [], deletes: [] }, { materialize }))
      .rejects.toThrow();
    expect(await readFile(join(root, ".git", "index.lock"), "utf8")).toBe("owned by another writer");
    expect(await readFile(join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("last applied\n");
  });

  it.each(["target", "source"])("preserves an independently advanced %s branch during failed managed apply", async (changedBranch) => {
    const root = await repository(`advance-ref-race-${changedBranch}`);
    const originalRef = (await git(root, "symbolic-ref", "--short", "HEAD")).trim();
    await git(root, "checkout", "-qb", "peer");
    await writeFile(join(root, "tracked.txt"), "peer baseline\n");
    await git(root, "add", "tracked.txt");
    await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "peer");
    const next = await captureWorkspace(root);
    const concurrentCommit = (await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid",
      "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "independent concurrent commit")).trim();
    await git(root, "checkout", "-q", originalRef);
    // The receiving peer branch predates the incoming revision.
    await git(root, "branch", "-f", "peer", "HEAD");
    await writeFile(join(root, "tracked.txt"), "last applied dirty overlay\n");
    const previous = await captureWorkspace(root);
    const index = await readFile(join(root, ".git", "index"));
    const ref = `refs/heads/${changedBranch === "target" ? "peer" : originalRef}`;
    await expect(applyWorkspaceTransaction([{ root, captured: next, expectedCurrent: previous, gitFetch: "auto" }], { writes: [], deletes: [] }, {
      materialize: async () => {
        await git(root, "update-ref", ref, concurrentCommit);
        throw new Error("injected failure after independent commit");
      },
    })).rejects.toThrow();
    expect((await git(root, "rev-parse", ref)).trim()).toBe(concurrentCommit);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("last applied dirty overlay\n");
    expect(await readFile(join(root, ".git", "index"))).toEqual(index);
    await expect(lstat(join(root, ".git", "index.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["new-branch", "detached", "unborn", "different-unborn"])("restores exact HEAD/ref state after a failed %s transition and permits retry", async (transition) => {
    const root = transition === "different-unborn" ? await unbornRepository("advance-ref-empty") : await repository(`advance-ref-${transition}`);
    const next = await captureWorkspace(root);
    if (transition === "new-branch" || transition === "different-unborn") next.capsule.headRef = "new-peer";
    if (transition === "detached") next.capsule.headRef = null;
    if (transition === "unborn") next.capsule.baseCommit = null;
    await writeFile(join(root, "tracked.txt"), "last applied dirty state\n");
    const previous = await captureWorkspace(root);
    const applications = [{ root, captured: next, expectedCurrent: previous, gitFetch: "auto" as const }];
    await expect(applyWorkspaceTransaction(applications, { writes: [], deletes: [] }, {
      materialize: async () => { throw new Error("injected transition failure"); },
    })).rejects.toThrow("injected transition failure");
    expect(await workspaceMatchesCapsule(root, previous)).toBe(true);
    if (transition === "new-branch" || transition === "different-unborn") {
      await expect(git(root, "show-ref", "--verify", "refs/heads/new-peer")).rejects.toThrow();
    }
    await applyWorkspaceTransaction(applications, { writes: [], deletes: [] }, { materialize });
    expect(await workspaceMatchesCapsule(root, next)).toBe(true);
  });

  it.each(["HEAD", "refs/heads/new-peer"])("preserves existing %s locks and undoes only a completed ref update", async (lockedRef) => {
    const root = await repository("advance-head-lock");
    const next = await captureWorkspace(root);
    next.capsule.headRef = "new-peer";
    await writeFile(join(root, "tracked.txt"), "last applied\n");
    const previous = await captureWorkspace(root);
    const lock = join(root, ".git", `${lockedRef}.lock`);
    await writeFile(lock, "foreign writer lock");
    let called = false;
    await expect(applyWorkspaceTransaction([{ root, captured: next, expectedCurrent: previous }], { writes: [], deletes: [] }, {
      materialize: async () => { called = true; },
    })).rejects.toThrow();
    expect(called).toBe(false);
    expect(await workspaceMatchesCapsule(root, previous)).toBe(true);
    expect(await readFile(lock, "utf8")).toBe("foreign writer lock");
    await expect(git(root, "show-ref", "--verify", "refs/heads/new-peer")).rejects.toThrow();
  });

  it("does not undo an independent symbolic HEAD switch during materialization failure", async () => {
    const root = await repository("advance-head-race");
    const next = await captureWorkspace(root);
    next.capsule.headRef = "new-peer";
    await writeFile(join(root, "tracked.txt"), "last applied\n");
    const previous = await captureWorkspace(root);
    await expect(applyWorkspaceTransaction([{ root, captured: next, expectedCurrent: previous }], { writes: [], deletes: [] }, {
      materialize: async () => {
        await git(root, "symbolic-ref", "HEAD", "refs/heads/independent");
        throw new Error("injected error after independent switch");
      },
    })).rejects.toBeInstanceOf(AggregateError);
    expect((await git(root, "symbolic-ref", "HEAD")).trim()).toBe("refs/heads/independent");
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("last applied\n");
  });

  it("holds the Git index lock through materialization and releases it after failure", async () => {
    const root = await repository("advance-held-lock");
    const next = await captureWorkspace(root);
    await writeFile(join(root, "tracked.txt"), "last applied\n");
    const previous = await captureWorkspace(root);
    await expect(applyWorkspaceTransaction([{ root, captured: next, expectedCurrent: previous }], { writes: [], deletes: [] }, {
      materialize: async () => {
        await expect(git(root, "add", "tracked.txt")).rejects.toThrow();
        throw new Error("injected failure while locked");
      },
    })).rejects.toThrow("injected failure while locked");
    await expect(lstat(join(root, ".git", "index.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await workspaceMatchesCapsule(root, previous)).toBe(true);
    await git(root, "add", "tracked.txt");
  });

  it.each(["write", "delete", "directory", "symlink"])("detects an editor %s after preparation at the materializer commit boundary", async (change) => {
    const root = await repository("advance-editor-race");
    const next = await captureWorkspace(root);
    await writeFile(join(root, "tracked.txt"), "last applied\n");
    const previous = await captureWorkspace(root);
    await expect(applyWorkspaceTransaction([{ root, captured: next, expectedCurrent: previous }], { writes: [], deletes: [] }, {
      materialize: async (transaction) => {
        const path = join(root, "tracked.txt");
        if (change === "write") await writeFile(path, "editor wrote during materialization\n");
        else {
          await rm(path);
          if (change === "directory") await mkdir(path);
          if (change === "symlink") await symlink("deleted.txt", path);
        }
        // Mirror the production materializer's per-target pre-commit boundary.
        for (const [index, write] of transaction.writes.entries()) await transaction.beforeCommit?.(index, write.path);
        await materialize(transaction);
      },
    })).rejects.toThrow("managed workspace target changed");
    if (change === "write") expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("editor wrote during materialization\n");
    if (change === "delete") await expect(lstat(join(root, "tracked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    if (change === "directory") expect((await lstat(join(root, "tracked.txt"))).isDirectory()).toBe(true);
    if (change === "symlink") expect(await readlink(join(root, "tracked.txt"))).toBe("deleted.txt");
    await expect(lstat(join(root, ".git", "index.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["removed", "replaced"])("does not delete a %s owned lock's successor", async (mutation) => {
    const root = await repository(`advance-lock-${mutation}`);
    const next = await captureWorkspace(root);
    await writeFile(join(root, "tracked.txt"), "last applied\n");
    const previous = await captureWorkspace(root);
    const lock = join(root, ".git", "index.lock");
    await expect(applyWorkspaceTransaction([{ root, captured: next, expectedCurrent: previous }], { writes: [], deletes: [] }, {
      materialize: async () => {
        await rm(lock);
        if (mutation === "replaced") await writeFile(lock, "another writer's successor lock");
        throw new Error("lock ownership changed");
      },
    })).rejects.toThrow("lock ownership changed");
    if (mutation === "replaced") expect(await readFile(lock, "utf8")).toBe("another writer's successor lock");
    else await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prepares a managed and a clean root together without applying either when a later lock is busy", async () => {
    const root = await repository("advance-multiple-first");
    const second = await repository("advance-multiple-second");
    const next = await captureWorkspace(root);
    const clean = await captureWorkspace(second);
    await writeFile(join(root, "tracked.txt"), "last applied\n");
    const previous = await captureWorkspace(root);
    await writeFile(join(second, ".git", "index.lock"), "busy");
    let called = false;
    const applications = [{ root, captured: next, expectedCurrent: previous }, { root: second, captured: clean }];
    await expect(applyWorkspaceTransaction(applications, { writes: [], deletes: [] }, {
      materialize: async () => { called = true; },
    })).rejects.toThrow();
    expect(called).toBe(false);
    expect(await workspaceMatchesCapsule(root, previous)).toBe(true);
    expect(await workspaceMatchesCapsule(second, clean)).toBe(true);
    await expect(lstat(join(root, ".git", "index.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(second, ".git", "index.lock"), "utf8")).toBe("busy");
    await rm(join(second, ".git", "index.lock"));
    await applyWorkspaceTransaction(applications, { writes: [], deletes: [] }, { materialize });
    expect(await workspaceMatchesCapsule(root, next)).toBe(true);
    expect(await workspaceMatchesCapsule(second, clean)).toBe(true);
  });

  it("advances unborn repositories with index additions, worktree deletions, and symlinks", async () => {
    const source = await unbornRepository("advance-unborn-source");
    const target = await unbornRepository("advance-unborn-target");
    await writeFile(join(source, "gone.txt"), "untracked\n");
    const previous = await captureWorkspace(source);
    await applyWorkspaceCapsule(target, previous, { materialize });
    await rm(join(source, "gone.txt"));
    await writeFile(join(source, "staged.txt"), "staged but missing from worktree\n");
    await symlink("staged.txt", join(source, "staged-link"));
    await git(source, "add", "staged.txt", "staged-link");
    await rm(join(source, "staged.txt"));
    await symlink("staged-link", join(source, "untracked-link"));
    const next = await captureWorkspace(source);
    await applyWorkspaceTransaction([{ root: target, captured: next, expectedCurrent: previous }], { writes: [], deletes: [] }, { materialize });
    expect(await workspaceMatchesCapsule(target, next)).toBe(true);
    expect(await readlink(join(target, "staged-link"))).toBe("staged.txt");
    expect(await readlink(join(target, "untracked-link"))).toBe("staged-link");
    await expect(readFile(join(target, "staged.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["ignored", "directory"])("refuses an incoming path colliding with local %s content", async (kind) => {
    const source = await repository(`advance-collision-source-${kind}`);
    const target = await repository(`advance-collision-target-${kind}`);
    await writeFile(join(source, "tracked.txt"), "managed dirty\n");
    const previous = await captureWorkspace(source);
    await applyWorkspaceCapsule(target, previous, { materialize });
    // Device-local exclusions never grant permission to destroy hidden data.
    await writeFile(join(target, ".git", "info", "exclude"), "collision\n");
    if (kind === "directory") await mkdir(join(target, "collision"));
    else await writeFile(join(target, "collision"), "private unsynced\n");
    await writeFile(join(source, "collision"), "peer file\n");
    const next = await captureWorkspace(source);
    await expect(applyWorkspaceTransaction([{ root: target, captured: next, expectedCurrent: previous }], { writes: [], deletes: [] }, { materialize }))
      .rejects.toThrow(kind === "directory" ? "non-file destination" : "unobserved local content");
    expect(await workspaceMatchesCapsule(target, previous)).toBe(true);
    if (kind === "directory") expect((await lstat(join(target, "collision"))).isDirectory()).toBe(true);
    else expect(await readFile(join(target, "collision"), "utf8")).toBe("private unsynced\n");
    await expect(lstat(join(target, ".git", "index.lock"))).rejects.toMatchObject({ code: "ENOENT" });
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

async function materialize(transaction: WorkspaceFileTransaction): Promise<void> {
  let index = 0;
  for (const path of transaction.deletes) {
    await transaction.beforeCommit?.(index++, path);
    await rm(path, { force: true });
  }
  for (const write of transaction.writes) {
    await transaction.beforeCommit?.(index++, write.path);
    await mkdir(dirname(write.path), { recursive: true });
    if (write.sourcePath !== undefined) await copyFile(write.sourcePath, write.path);
    else await writeFile(write.path, write.bytes);
    if (write.mode !== undefined) await chmod(write.path, write.mode);
  }
  for (const link of transaction.symlinks ?? []) {
    await transaction.beforeCommit?.(index++, link.path);
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

async function lfsPointerRepository(name: string, content: Buffer): Promise<{
  content: Buffer;
  pointer: string;
  root: string;
}> {
  const root = await repository(name);
  const pointer = lfsPointer(createHash("sha256").update(content).digest("hex"), content.byteLength);
  await writeFile(join(root, ".gitattributes"), "asset.bin filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(join(root, "asset.bin"), pointer);
  await git(root, "add", ".gitattributes", "asset.bin");
  await git(root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "LFS baseline");
  await git(root, "remote", "add", "origin", "file:///does-not-matter-to-fixture");
  await git(root, "update-index", "--skip-worktree", "asset.bin");
  return { content, pointer, root };
}

async function fakeGitLfs(content: Uint8Array): Promise<{
  environment: Record<string, string>;
  failCheckout: string;
  failFetch: string;
  failVersion: string;
  fetched: string;
  log: string;
  suppressMaterialization: string;
}> {
  // Docker deliberately mounts /tmp noexec; place the fake executable under the test workspace.
  const root = await mkdtemp(join(process.cwd(), ".statecase-fake-lfs-"));
  temporary.push(root);
  const executable = join(root, "git-lfs");
  const object = join(root, "object.bin");
  const log = join(root, "commands.log");
  const failCheckout = join(root, "fail-checkout");
  const failFetch = join(root, "fail-fetch");
  const failVersion = join(root, "fail-version");
  const fetched = join(root, "fetched");
  const suppressMaterialization = join(root, "suppress-materialization");
  await writeFile(object, content);
  await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$STATECASE_TEST_LFS_LOG"
case "$1" in
  version)
    if [ -f "$STATECASE_TEST_LFS_FAIL_VERSION" ]; then exit 1; fi
    printf '%s\\n' 'git-lfs/3.7.1 (fixture)'
    ;;
  fetch)
    if [ -f "$STATECASE_TEST_LFS_FAIL_FETCH" ]; then
      printf '%s\\n' 'fixture-secret must be redacted' >&2
      exit 1
    fi
    : > "$STATECASE_TEST_LFS_FETCHED"
    ;;
  checkout)
    if [ -f "$STATECASE_TEST_LFS_FAIL_CHECKOUT" ]; then exit 1; fi
    if [ -f "$STATECASE_TEST_LFS_SUPPRESS_MATERIALIZATION" ]; then exit 0; fi
    if [ -f "$STATECASE_TEST_LFS_FETCHED" ]; then
      cp "$STATECASE_TEST_LFS_OBJECT" asset.bin
    fi
    ;;
  *) exit 2 ;;
esac
`);
  await chmod(executable, 0o700);
  return {
    environment: {
      PATH: `${root}:${process.env.PATH ?? ""}`,
      STATECASE_TEST_LFS_FAIL_CHECKOUT: failCheckout,
      STATECASE_TEST_LFS_FAIL_FETCH: failFetch,
      STATECASE_TEST_LFS_FAIL_VERSION: failVersion,
      STATECASE_TEST_LFS_FETCHED: fetched,
      STATECASE_TEST_LFS_LOG: log,
      STATECASE_TEST_LFS_OBJECT: object,
      STATECASE_TEST_LFS_SUPPRESS_MATERIALIZATION: suppressMaterialization,
    },
    failCheckout,
    failFetch,
    failVersion,
    fetched,
    log,
    suppressMaterialization,
  };
}

async function withEnvironment<T>(environment: Record<string, string>, action: () => Promise<T>): Promise<T> {
  const prior = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    return await action();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
