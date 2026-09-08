import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceReferencePlan } from "@statecase/workspace";
import type { LocalConfig } from "../src/config.js";
import { prepareGitIndexes } from "../src/git-index-participant.js";
import { prepareGitReferences, validateGitReferences } from "../src/git-reference-participant.js";

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
  return { root, workspace, metadata: join(workspace, ".git"), git, indexes, plan };
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
});
