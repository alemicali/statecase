import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceReferencePlan } from "@statecase/workspace";
import type { LocalConfig } from "../src/config.js";
import { prepareGitIndexes } from "../src/git-index-participant.js";
import { prepareGitReferences, retainPinOwnership, retireGitPins, validateGitReferences } from "../src/git-reference-participant.js";

vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
const execute = promisify(execFile), roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "statecase-reference-"))); roots.push(root);
  const workspace = join(root, "workspace"); await fs.mkdir(workspace);
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty-config"),
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@statecase.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@statecase.invalid" } as unknown as NodeJS.ProcessEnv;
  const git = async (...args: string[]) => (await execute("git", ["-C", workspace, ...args], { env })).stdout.trim();
  await git("init", "-q", "-b", "main"); await fs.writeFile(join(workspace, "note"), "baseline");
  await git("add", "note"); await git("commit", "-qm", "baseline"); const before = await git("rev-parse", "HEAD");
  await fs.writeFile(join(workspace, "note"), "incoming"); await git("commit", "-qam", "incoming"); const after = await git("rev-parse", "HEAD");
  await git("reset", "--hard", before);
  const config: LocalConfig = { version: 1, apiUrl: "https://fixture.invalid", mappings: [], workspaces: [{ id: "project", path: workspace, sync: "git" }], applied: {} };
  const indexes = await prepareGitIndexes(config, [workspace]);
  const plan: WorkspaceReferencePlan = { root: workspace, indexPath: join(workspace, ".git", "index"),
    before: { baseCommit: before, headRef: "main" }, after: { baseCommit: after, headRef: "incoming" }, targetOriginalCommit: null };
  return { root, workspace, metadata: join(workspace, ".git"), git, indexes, plan, config };
}
describe("derived reference participant authority and stable observations (RT-006, WS-034)", () => {
  it("prepares without advancing native refs and wipes all returned bytes on disposal", async () => {
    const f = await fixture(), prepared = await prepareGitReferences(f.indexes, [f.plan]);
    expect(await f.git("rev-parse", "HEAD")).toBe(f.plan.before.baseCommit);
    await expect(f.git("rev-parse", "--verify", "refs/heads/incoming")).rejects.toThrow();
    expect(prepared.retentionWrites).toHaveLength(2); await prepared.guard();
    for (const lock of prepared.participant.locks) await expect(fs.lstat(lock.path)).rejects.toMatchObject({ code: "ENOENT" });
    prepared.dispose(); for (const write of [...prepared.files.writes, ...prepared.retentionWrites]) expect(write.bytes!.every(byte => byte === 0)).toBe(true);
  });
  it.each(["lock-path", "lock-root", "missing-lock", "pin-path", "pin-oid", "missing-pin", "root", "index", "unknown"])("refuses forged %s authority", async kind => {
    const f = await fixture(), prepared = await prepareGitReferences(f.indexes, [f.plan]), forged = structuredClone(prepared.participant);
    if (kind === "lock-path") forged.locks[0].path = join(f.root, "foreign.lock");
    if (kind === "lock-root") forged.locks[0].root = f.root;
    if (kind === "missing-lock") forged.locks.pop();
    if (kind === "pin-path") forged.pins[0].path = join(f.root, "foreign");
    if (kind === "pin-oid") forged.pins[0].oid = "a".repeat(40);
    if (kind === "missing-pin") forged.pins.pop();
    if (kind === "root") forged.plans[0].root = f.root;
    if (kind === "index") forged.plans[0].indexPath = join(f.root, "index");
    if (kind === "unknown") Object.assign(forged, { unknown: true });
    expect(() => validateGitReferences(f.indexes, forged)).toThrow(); prepared.dispose();
  });
  it.each(["HEAD", "refs/heads/main", "packed-refs", "logs/HEAD"])("refuses a changed %s source without treating a path-filtered guard as whole admission", async name => {
    const f = await fixture(), prepared = await prepareGitReferences(f.indexes, [f.plan]);
    await fs.writeFile(join(f.metadata, name), "foreign content");
    await expect(prepared.guard(join(f.root, "irrelevant"))).resolves.toBeUndefined();
    await expect(prepared.guard()).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" }); prepared.dispose();
  });
  it.each(["symlink", "hardlink", "directory", "oversized", "unterminated"])("refuses unsafe %s reflog observations", async kind => {
    const f = await fixture(), path = join(f.metadata, "logs", "HEAD");
    if (kind === "symlink") { await fs.rm(path); await fs.symlink(join(f.workspace, "note"), path); }
    if (kind === "hardlink") await fs.link(path, join(f.root, "alias"));
    if (kind === "directory") { await fs.rm(path); await fs.mkdir(path); }
    if (kind === "oversized") await fs.truncate(path, 32 * 1024 * 1024 + 1);
    if (kind === "unterminated") await fs.writeFile(path, "missing newline");
    await expect(prepareGitReferences(f.indexes, [f.plan])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
  });
  it("rejects a substituted descriptor even when the named file and returned bytes are unchanged", async () => {
    const f = await fixture(), head = join(f.metadata, "HEAD"), other = join(f.root, "other");
    await fs.writeFile(other, await fs.readFile(head)); const originalOpen = fs.open; let reads = 0;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === head && ++reads === 2) return originalOpen(other, args[1], args[2]);
      return originalOpen(...args);
    });
    await expect(prepareGitReferences(f.indexes, [f.plan])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    expect(reads).toBeGreaterThanOrEqual(2);
  });
  it("refuses invalid UTF-8 packed reference bytes instead of normalizing unrelated names", async () => {
    const f = await fixture(); await fs.writeFile(join(f.metadata, "packed-refs"), Buffer.concat([Buffer.from("# synthetic "), Buffer.from([0xff]), Buffer.from("\n")]));
    await expect(prepareGitReferences(f.indexes, [f.plan])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
  });
  it.each(["true", "always", "yes", "on", "2", "-1"])("honors Git's enabled reflog value %s", async value => {
    const f = await fixture(); await f.git("config", "core.logAllRefUpdates", value);
    const prepared = await prepareGitReferences(f.indexes, [f.plan]);
    expect(prepared.files.writes.some(write => write.path === join(f.metadata, "logs", "refs", "heads", "incoming"))).toBe(true); prepared.dispose();
  });
  it.each(["false", "no", "off", "0", ""])("preserves existing logs without creating disabled logs for %s", async value => {
    const f = await fixture(); await f.git("config", "core.logAllRefUpdates", value);
    const prepared = await prepareGitReferences(f.indexes, [f.plan]);
    expect(prepared.files.writes.some(write => write.path === join(f.metadata, "logs", "refs", "heads", "incoming"))).toBe(false);
    expect(prepared.files.writes.some(write => write.path === join(f.metadata, "logs", "HEAD"))).toBe(true); prepared.dispose();
  });
  it("refuses an existing collector marker without deleting or interpreting it", async () => {
    const f = await fixture(); await fs.writeFile(join(f.metadata, "gc.pid"), "synthetic stale pid");
    await expect(prepareGitReferences(f.indexes, [f.plan])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    expect(await fs.readFile(join(f.metadata, "gc.pid"), "utf8")).toBe("synthetic stale pid");
  });
  it.each(["missing-head", "bad-head", "wrong-head", "old-commit", "target-commit", "symbolic-branch", "duplicate-root", "missing-index", "wrong-index"])("refuses inconsistent %s plans before acquiring native locks", async kind => {
    const f = await fixture(); let plans = [f.plan], indexes = f.indexes;
    if (kind === "missing-head") await fs.rm(join(f.metadata, "HEAD"));
    if (kind === "bad-head") await fs.writeFile(join(f.metadata, "HEAD"), "invalid\n");
    if (kind === "wrong-head") f.plan.before.headRef = "other";
    if (kind === "old-commit") f.plan.before.baseCommit = f.plan.after.baseCommit;
    if (kind === "target-commit") f.plan.targetOriginalCommit = f.plan.before.baseCommit;
    if (kind === "symbolic-branch") await fs.writeFile(join(f.metadata, "refs", "heads", "main"), "ref: refs/heads/other\n");
    if (kind === "duplicate-root") { plans = [f.plan, f.plan]; indexes = [...indexes, ...indexes]; }
    if (kind === "missing-index") indexes = [];
    if (kind === "wrong-index") f.plan.indexPath = join(f.root, "index");
    await expect(prepareGitReferences(indexes, plans)).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    await expect(fs.lstat(join(f.metadata, "HEAD.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["bad", "duplicate", "orphan-peeled", "bad-peeled", "bad-name"])("rejects malformed %s packed refs", async kind => {
    const f = await fixture(), oid = f.plan.before.baseCommit!;
    const contents = { bad: "malformed\n", duplicate: `${oid} refs/tags/a\n${oid} refs/tags/a\n`, "orphan-peeled": `^${oid}\n`,
      "bad-peeled": `${oid} refs/tags/a\n^invalid\n`, "bad-name": `${oid} refs/heads/../outside\n` };
    await fs.writeFile(join(f.metadata, "packed-refs"), contents[kind as keyof typeof contents]);
    await expect(prepareGitReferences(f.indexes, [f.plan])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
  });
  it("preserves unrelated packed/peeled entries when removing an unborn target with no reflog", async () => {
    const f = await fixture(), oid = f.plan.before.baseCommit!, unrelated = `${oid} refs/tags/retained\n^${oid}\n`;
    await fs.writeFile(join(f.metadata, "packed-refs"), `${oid} refs/heads/incoming\n^${oid}\n${unrelated}`);
    f.plan.after.baseCommit = null; f.plan.targetOriginalCommit = oid;
    const prepared = await prepareGitReferences(f.indexes, [f.plan]);
    expect(Buffer.from(prepared.files.writes.find(write => write.path === join(f.metadata, "packed-refs"))!.bytes!).toString()).toBe(unrelated);
    expect(prepared.files.deletes).toEqual([]); prepared.dispose();
  });
  it.each(["same-branch", "unchanged", "detached-before", "unborn-before", "unborn-to-unborn"])("prepares the %s native transition", async kind => {
    const f = await fixture();
    if (kind === "same-branch" || kind === "unchanged") { f.plan.after.headRef = "main"; f.plan.targetOriginalCommit = f.plan.before.baseCommit; }
    if (kind === "unchanged") f.plan.after.baseCommit = f.plan.before.baseCommit;
    if (kind === "detached-before") { await f.git("checkout", "--detach", "-q"); f.plan.before.headRef = null; }
    if (kind.startsWith("unborn")) { await f.git("checkout", "--orphan", "empty"); f.plan.before = { headRef: "empty", baseCommit: null }; }
    if (kind === "unborn-to-unborn") f.plan.after.baseCommit = null;
    const prepared = await prepareGitReferences(f.indexes, [f.plan]);
    if (kind === "unchanged") expect(prepared.files.writes).toEqual([]);
    else expect(prepared.files.writes.length).toBeGreaterThan(0);
    if (kind === "unborn-to-unborn") expect(prepared.retentionWrites).toEqual([]);
    prepared.dispose();
  });
  it.each(["files", "reftable", "absent-log", "invalid-log", "valueless-log"])("uses native configuration for %s", async kind => {
    const f = await fixture();
    if (kind === "files" || kind === "reftable") await f.git("config", "extensions.refStorage", kind);
    if (kind === "absent-log" || kind === "valueless-log") await f.git("config", "--unset", "core.logAllRefUpdates");
    if (kind === "valueless-log") await fs.appendFile(join(f.metadata, "config"), "\n[core]\nlogAllRefUpdates\n");
    if (kind === "invalid-log") await f.git("config", "core.logAllRefUpdates", "invalid");
    if (kind === "reftable" || kind === "invalid-log") await expect(prepareGitReferences(f.indexes, [f.plan])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    else { const prepared = await prepareGitReferences(f.indexes, [f.plan]); expect(prepared.files.writes.length).toBeGreaterThan(0); prepared.dispose(); }
  });
  it("deduplicates common-directory pins and locks across distinct linked worktrees", async () => {
    const f = await fixture(), linked = join(f.root, "linked"); await f.git("worktree", "add", "-qb", "linked", linked);
    f.config.workspaces.push({ id: "linked", path: linked, sync: "git" });
    const indexes = await prepareGitIndexes(f.config, [f.workspace, linked]);
    const second = { ...f.plan, root: linked, indexPath: indexes[1].layout.indexPath, before: { ...f.plan.before, headRef: "linked" }, after: { ...f.plan.after, headRef: "incoming-two" } };
    const prepared = await prepareGitReferences(indexes, [f.plan, second]);
    expect(prepared.participant.pins).toHaveLength(2);
    expect(prepared.participant.locks.filter(lock => lock.path === join(f.metadata, "packed-refs.lock"))).toHaveLength(1); prepared.dispose();
    await expect(prepareGitReferences(indexes, [f.plan, { ...second, after: f.plan.after }])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
  });
  it.each(["missing", "changed", "unowned", "no-fingerprint"])("refuses %s retention evidence", async kind => {
    const f = await fixture(), prepared = await prepareGitReferences(f.indexes, [f.plan]);
    if (kind === "missing") await expect(prepared.verifyRetention()).rejects.toThrow();
    if (kind === "changed" || kind === "unowned") {
      await fs.writeFile(prepared.participant.pins[0].path, "foreign\n");
      if (kind === "changed") await expect(prepared.verifyRetention()).rejects.toThrow();
      else await expect(retireGitPins(f.indexes, prepared.participant, false)).rejects.toThrow();
    }
    if (kind === "no-fingerprint") {
      expect(() => retainPinOwnership(prepared.participant, [])).toThrow();
      await expect(retireGitPins(f.indexes, prepared.participant, true)).rejects.toThrow();
    }
    prepared.dispose();
  });
  it.each(["short-read", "changed-fd", "replaced-name"])("refuses %s during native metadata observation", async kind => {
    const f = await fixture(), path = join(f.metadata, "HEAD"), originalOpen = fs.open; let reads = 0;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === path && ++reads === 2) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(async (...args: Parameters<typeof handle.read>) => {
          const result = await read(...args);
          if (kind === "short-read") return { ...result, bytesRead: 0 };
          if (kind === "changed-fd") await fs.writeFile(path, "changed\n");
          if (kind === "replaced-name") { await fs.rename(path, `${path}-old`); await fs.writeFile(path, "ref: refs/heads/main\n"); }
          return result;
        });
      }
      return handle;
    });
    await expect(prepareGitReferences(f.indexes, [f.plan])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
  });
  it.each(["gc-stat", "mkdir"])("fails closed on %s I/O errors without raw diagnostics", async kind => {
    const f = await fixture(), failure = Object.assign(new Error("private fixture diagnostic"), { code: "EACCES" });
    if (kind === "gc-stat") { const stat = fs.lstat; vi.spyOn(fs, "lstat").mockImplementation((...args: Parameters<typeof fs.lstat>) => args[0] === join(f.metadata, "gc.pid") ? Promise.reject(failure) : stat(...args)); }
    else vi.spyOn(fs, "mkdir").mockRejectedValueOnce(failure);
    await expect(prepareGitReferences(f.indexes, [f.plan])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED", message: expect.not.stringContaining("private fixture") });
  });
});
