import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalConfig } from "../src/config.js";
import { gitIndexGrants, prepareGitIndexes, validateGitIndexes } from "../src/git-index-participant.js";
import { releaseNativeLock } from "../src/native-lock.js";

const execute = promisify(execFile), temporary: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "statecase-git-authority-")); temporary.push(root);
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty-config") } as unknown as NodeJS.ProcessEnv;
  await execute("git", ["-C", workspace, "init", "-q", "-b", "main"], { env });
  const config: LocalConfig = { version: 1, apiUrl: "https://fixture.invalid", mappings: [], workspaces: [{ id: "project", path: workspace, sync: "git" }], applied: {} };
  return { root, workspace, config, env };
}
async function separate(f: Awaited<ReturnType<typeof fixture>>) {
  const gitDir = join(f.root, "metadata"); await rename(join(f.workspace, ".git"), gitDir);
  await writeFile(join(f.workspace, ".git"), "gitdir: ../metadata\n"); return gitDir;
}
async function release(plans: Awaited<ReturnType<typeof prepareGitIndexes>>) {
  for (const participant of plans) await releaseNativeLock(participant.lock, { grants: gitIndexGrants(plans) });
}
async function proxy(f: Awaited<ReturnType<typeof fixture>>, script: string) {
  const bin = join(f.root, "bin"); await mkdir(bin); await writeFile(join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
}
describe("repository-derived exact index authority (RT-006, WS-034)", () => {
  it("supports relative gitfiles and revalidates while HEAD is absent without invoking Git", async () => {
    const f = await fixture(), gitDir = await separate(f), plans = await prepareGitIndexes(f.config, [f.workspace]);
    expect(plans[0].layout.indexPath).toBe(join(gitDir, "index"));
    await rm(join(gitDir, "HEAD")); vi.stubEnv("PATH", join(f.root, "missing-binaries"));
    await validateGitIndexes(f.config, plans); await release(plans);
  });
  it("ignores ambient Git routing and config injection during admission", async () => {
    const f = await fixture();
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CONFIG_GLOBAL"]) vi.stubEnv(key, join(f.root, "foreign"));
    vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("GIT_CONFIG_KEY_0", "core.worktree"); vi.stubEnv("GIT_CONFIG_VALUE_0", join(f.root, "foreign"));
    const plans = await prepareGitIndexes(f.config, [f.workspace]);
    expect(plans[0].layout.gitDir).toBe(join(f.workspace, ".git")); await release(plans);
  });
  it.each(["gitfile-content", "gitfile-inode", "gitdir", "workspace", "commondir"])("refuses a changed %s locator before granting recovery", async kind => {
    const f = await fixture(), gitDir = await separate(f), plans = await prepareGitIndexes(f.config, [f.workspace]);
    if (kind === "gitfile-content") await writeFile(join(f.workspace, ".git"), `gitdir: ${gitDir}\n`);
    if (kind === "gitfile-inode") { const content = await readFile(join(f.workspace, ".git")); await rm(join(f.workspace, ".git")); await writeFile(join(f.workspace, ".git"), content); }
    if (kind === "gitdir") { await rename(gitDir, `${gitDir}-old`); await mkdir(gitDir); }
    if (kind === "workspace") { await rename(f.workspace, `${f.workspace}-old`); await mkdir(f.workspace); await writeFile(join(f.workspace, ".git"), `gitdir: ${gitDir}\n`); }
    if (kind === "commondir") await writeFile(join(gitDir, "commondir"), ".\n");
    await expect(validateGitIndexes(f.config, plans)).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
  });
  it.each(["root", "index", "gitdir", "lock-path", "lock-root", "observation", "unknown", "duplicate", "excess"])("rejects forged %s descriptors", async kind => {
    const f = await fixture(), plans = await prepareGitIndexes(f.config, [f.workspace]), forged = structuredClone(plans);
    if (kind === "root") forged[0].layout.root = f.root;
    if (kind === "index") forged[0].layout.indexPath = join(f.root, "outside");
    if (kind === "gitdir") forged[0].layout.gitDir = f.root;
    if (kind === "lock-path") forged[0].lock.path = join(f.root, "foreign.lock");
    if (kind === "lock-root") forged[0].lock.root = f.root;
    if (kind === "observation") forged[0].layout.observations[0].identity = "forged";
    if (kind === "unknown") Object.assign(forged[0], { unknown: true });
    if (kind === "duplicate") forged.push(forged[0]);
    if (kind === "excess") while (forged.length <= 32) forged.push(forged[0]);
    await expect(validateGitIndexes(f.config, forged)).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" }); await release(plans);
  });
  it.each(["empty", "oversized", "invalid", "multiline", "utf8", "symlink", "hardlink", "control"])("refuses an unsafe %s gitfile before native anchor allocation", async kind => {
    const f = await fixture(), gitDir = await separate(f), locator = join(f.workspace, ".git");
    if (kind === "empty") await writeFile(locator, "");
    if (kind === "oversized") await writeFile(locator, "x".repeat(4097));
    if (kind === "invalid") await writeFile(locator, "not gitdir");
    if (kind === "multiline") await writeFile(locator, "gitdir: ../metadata\nextra\n");
    if (kind === "utf8") await writeFile(locator, Buffer.from([0xff]));
    if (kind === "symlink") { await rm(locator); await symlink(gitDir, locator); }
    if (kind === "hardlink") await link(locator, join(f.root, "alias"));
    if (kind === "control") await writeFile(locator, "gitdir: ../bad\u0000path\n");
    await expect(prepareGitIndexes(f.config, [f.workspace])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    expect((await readdir(gitDir)).some(name => name.includes("statecase"))).toBe(false);
  });
  it.each(["relative", "too-many", "noncanonical", "control", "missing", "symlink"])("refuses %s selected roots", async kind => {
    const f = await fixture(); let root = f.workspace, roots = [root];
    if (kind === "relative") roots = ["workspace"];
    if (kind === "too-many") roots = Array.from({ length: 33 }, (_, index) => join(f.root, String(index)));
    if (kind === "noncanonical") roots = [`${root}/../workspace`];
    if (kind === "control") roots = [`${root}\n`];
    if (kind === "missing") await rm(root, { recursive: true });
    if (kind === "symlink") { await rename(root, `${root}-original`); await symlink(`${root}-original`, root); }
    await expect(prepareGitIndexes(f.config, roots)).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
  });
  it.each(["wrong", "extra", "relative", "error", "changed"])("refuses Git %s observations without leaking raw diagnostics", async kind => {
    const f = await fixture();
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    const lines = [f.workspace, join(f.workspace, ".git"), join(f.workspace, ".git"), join(f.workspace, ".git", "index")];
    if (kind === "wrong") lines[3] = join(f.workspace, ".git", "config");
    if (kind === "extra") lines.push("extra");
    if (kind === "relative") lines[0] = "relative";
    await proxy(f, kind === "error" ? "echo SENSITIVE_FIXTURE >&2; exit 1" : `${kind === "changed" ? `chmod 700 ${quote(f.workspace)}\n` : ""}printf '%s\\n' ${lines.map(quote).join(" ")}`);
    if (kind === "changed") await chmod(f.workspace, 0o755);
    await expect(prepareGitIndexes(f.config, [f.workspace])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED", message: expect.not.stringContaining("SENSITIVE_FIXTURE") });
    expect((await readdir(join(f.workspace, ".git"))).some(name => name.includes("statecase"))).toBe(false);
  });
  it("refuses two selected workspaces aliasing the same native index", async () => {
    const f = await fixture(), gitDir = await separate(f), second = join(f.root, "second"); await mkdir(second);
    await writeFile(join(second, ".git"), `gitdir: ${gitDir}\n`); f.config.workspaces.push({ id: "second", path: second });
    await expect(prepareGitIndexes(f.config, [f.workspace, second])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    expect((await readdir(gitDir)).some(name => name.includes("statecase"))).toBe(false);
  });
  it("bounds and validates commondir pointers and rejects missing metadata parents", async () => {
    const f = await fixture(), gitDir = await separate(f);
    for (const content of ["\n", "../missing\n", "bad\nextra\n"]) {
      await writeFile(join(gitDir, "commondir"), content);
      await expect(prepareGitIndexes(f.config, [f.workspace])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    }
    await expect(lstat(join(dirname(gitDir), "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["symlink", "hardlink", "directory"])("refuses a pre-existing %s index without changing it", async kind => {
    const f = await fixture(), index = join(f.workspace, ".git", "index"), foreign = join(f.root, "foreign");
    await writeFile(foreign, "foreign bytes");
    if (kind === "symlink") await symlink(foreign, index);
    if (kind === "hardlink") await link(foreign, index);
    if (kind === "directory") await mkdir(index);
    await expect(prepareGitIndexes(f.config, [f.workspace])).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    expect(await readFile(foreign, "utf8")).toBe("foreign bytes");
    expect((await readdir(join(f.workspace, ".git"))).some(name => name.includes("statecase"))).toBe(false);
  });
});
