import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { captureWorkspace } from "@statecase/workspace";
import { ConfigStore } from "../src/config.js";

const execute = promisify(execFile), temporary: string[] = [];
let bundleRoot: string, configBundle: string, workspaceBundle: string;
function environment(root: string) {
  return { PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty-config"), GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@statecase.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@statecase.invalid" } as unknown as NodeJS.ProcessEnv;
}
async function git(root: string, ...args: string[]) { return (await execute("git", ["-C", root, ...args], { env: environment(root) })).stdout.trim(); }
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "statecase-workspace-profile-bundle-")); configBundle = join(bundleRoot, "config.mjs"); workspaceBundle = join(bundleRoot, "workspace.mjs");
  const options = { bundle: true, platform: "node" as const, format: "esm" as const, target: "node22", logLevel: "silent" as const };
  await build({ ...options, entryPoints: [fileURLToPath(new URL("../src/config.ts", import.meta.url))], outfile: configBundle,
    plugins: [{ name: "isolated-native-module", setup(builder) { builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: createRequire(import.meta.url).resolve("better-sqlite3"), external: true })); } }] });
  await build({ ...options, entryPoints: [fileURLToPath(new URL("../../../packages/workspace/src/index.ts", import.meta.url))], outfile: workspaceBundle });
});
afterAll(async () => { await rm(bundleRoot, { recursive: true, force: true }); });
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(kind: "branch" | "packed" | "detached" | "unborn" = "branch") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "statecase-workspace-profile-"))); temporary.push(root);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1"); vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "empty-config")); vi.stubEnv("GIT_OPTIONAL_LOCKS", "0");
  const source = join(root, "source"), target = join(root, "target"), home = join(root, "profile"); await mkdir(source);
  await git(source, "init", "-q", "-b", "main"); await writeFile(join(source, "note"), "baseline");
  await git(source, "add", "note"); await git(source, "commit", "-qm", "baseline");
  await git(root, "clone", "-q", "--no-local", source, target);
  const beforeCommit = await git(target, "rev-parse", "HEAD"), beforeHead = await readFile(join(target, ".git", "HEAD")), beforeIndex = await readFile(join(target, ".git", "index"));
  if (kind === "packed") { await git(target, "branch", "incoming"); await git(target, "pack-refs", "--all", "--prune"); }
  if (kind === "unborn") { await git(source, "checkout", "--orphan", "empty"); await git(source, "rm", "-q", "-rf", "."); }
  else {
    await writeFile(join(source, "note"), "incoming baseline"); await git(source, "add", "note"); await git(source, "commit", "-qm", "incoming");
    if (kind === "detached") await git(source, "checkout", "--detach", "-q"); else await git(source, "switch", "-qc", "incoming");
    await writeFile(join(source, "note"), "incoming staged"); await git(source, "add", "note"); await writeFile(join(source, "note"), "incoming worktree");
  }
  await writeFile(join(source, "untracked"), "untracked work");
  const captured = await captureWorkspace(source), expectedCurrent = await captureWorkspace(target), store = new ConfigStore(home), config = await store.loadConfig();
  config.workspaces = [{ id: "project", path: target, sync: "git", gitFetch: "auto" }]; await store.saveConfig(config);
  return { root, source, target, home, beforeCommit, beforeHead, beforeIndex, captured, expectedCurrent, store, original: await readFile(join(home, "config.json"), "utf8") };
}
async function child(f: Awaited<ReturnType<typeof fixture>>, script: string) {
  const code = `import {ConfigStore} from ${JSON.stringify(pathToFileURL(configBundle).href)}; import {captureWorkspace} from ${JSON.stringify(pathToFileURL(workspaceBundle).href)}; import {readFile} from "node:fs/promises"; ${script}`;
  const proc = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: f.root, env: environment(f.root), stdio: "ignore" });
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 15000);
  const result = await new Promise((resolve, reject) => { proc.once("error", reject); proc.once("exit", (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
  expect(timedOut).toBe(false); return result;
}
function applyScript(f: Awaited<ReturnType<typeof fixture>>, phase: string, nativePath?: string) {
  return `const store=new ConfigStore(${JSON.stringify(f.home)}),config=await store.loadConfig(),captured=await captureWorkspace(${JSON.stringify(f.source)});
    config.applied.project={revisionId:"incoming",digests:{}};
    await store.materializeWorkspaceConfig(config,[{root:${JSON.stringify(f.target)},captured,gitFetch:"auto"}],{writes:[],deletes:[]},{afterBoundary:async(phase,index)=>{
      if(phase!==${JSON.stringify(phase)})return;
      ${nativePath ? `const plan=JSON.parse((await readFile(${JSON.stringify(join(f.home, "materialization", "active.jsonl"))},"utf8")).split(String.fromCharCode(10))[0]);if(plan.targets[index]?.path!==${JSON.stringify(nativePath)})return;` : ""}
      process.kill(process.pid,"SIGKILL");}});`;
}
describe("prepared workspace and profile share one durable decision (RT-006, WS-034)", () => {
  it.each(["branch", "packed", "detached", "unborn"] as const)("publishes the complete %s workspace with its profile", async kind => {
    const f = await fixture(kind), config = await f.store.loadConfig(); config.applied.project = { revisionId: "incoming", digests: {} };
    await f.store.materializeWorkspaceConfig(config, [{ root: f.target, captured: f.captured, gitFetch: "auto", expectedCurrent: f.expectedCurrent }], { writes: [], deletes: [] });
    const current = await captureWorkspace(f.target);
    expect(current.capsule).toEqual(f.captured.capsule);
    expect((await f.store.loadConfig()).applied.project.revisionId).toBe("incoming");
    expect(await git(f.target, "rev-parse", "refs/heads/main")).toBe(f.beforeCommit);
    await git(f.target, "add", "untracked");
  });
  it.each(["backup", "install"])("recovers original HEAD, refs, index, worktree and profile after HEAD %s", async phase => {
    const f = await fixture("packed");
    expect(await child(f, applyScript(f, phase, join(f.target, ".git", "HEAD")))).toEqual({ code: null, signal: "SIGKILL" });
    await expect(f.store.loadConfig()).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    expect(await f.store.recoverMaterialization({ dryRun: true })).toMatchObject({ outcome: "rollback" });
    expect(await child(f, `await new ConfigStore(${JSON.stringify(f.home)}).recoverMaterialization();`)).toEqual({ code: 0, signal: null });
    expect(await readFile(join(f.target, ".git", "HEAD"))).toEqual(f.beforeHead);
    expect(await readFile(join(f.target, ".git", "index"))).toEqual(f.beforeIndex);
    expect(await git(f.target, "rev-parse", "refs/heads/incoming")).toBe(f.beforeCommit);
    expect(await readFile(join(f.target, "note"), "utf8")).toBe("baseline");
    expect(await readFile(join(f.home, "config.json"), "utf8")).toBe(f.original);
    expect(await f.store.recoverMaterialization()).toMatchObject({ pending: false });
  });
  it("keeps branch and detached/native metadata paired with the committed profile after process death", async () => {
    const f = await fixture();
    expect(await child(f, applyScript(f, "commit"))).toEqual({ code: null, signal: "SIGKILL" });
    await f.store.recoverMaterialization();
    expect((await captureWorkspace(f.target)).capsule).toEqual(f.captured.capsule);
    expect((await f.store.loadConfig()).applied.project.revisionId).toBe("incoming");
  });
  it("retains old/new commit roots before operational mutation and releases owned pins after commit", async () => {
    const f = await fixture(), config = await f.store.loadConfig(); let checked = false;
    config.applied.project = { revisionId: "incoming", digests: {} };
    await f.store.materializeWorkspaceConfig(config, [{ root: f.target, captured: f.captured, gitFetch: "auto" }], { writes: [], deletes: [] }, {
      afterBoundary: async (phase, index) => {
        if (phase !== "backup") return;
        const plan = JSON.parse((await readFile(join(f.home, "materialization", "active.jsonl"), "utf8")).split("\n")[0]);
        if (plan.targets[index].path !== join(f.target, "note")) return;
        const pins = await git(f.target, "for-each-ref", "--format=%(objectname)", "refs/statecase/transactions/");
        expect(pins.split("\n")).toEqual(expect.arrayContaining([f.beforeCommit, f.captured.capsule.baseCommit]));
        await expect(git(f.target, "gc", "--prune=now")).rejects.toThrow(); checked = true;
      },
    });
    expect(checked).toBe(true); expect(await git(f.target, "for-each-ref", "refs/statecase/transactions/")).toBe("");
  });
  it("records native HEAD and branch reflog transitions in the same decision", async () => {
    const f = await fixture(), config = await f.store.loadConfig(), oldLog = await readFile(join(f.target, ".git", "logs", "HEAD"), "utf8");
    await f.store.materializeWorkspaceConfig(config, [{ root: f.target, captured: f.captured, gitFetch: "auto" }], { writes: [], deletes: [] });
    const log = await readFile(join(f.target, ".git", "logs", "HEAD"), "utf8");
    expect(log.startsWith(oldLog)).toBe(true);
    expect(log.slice(oldLog.length)).toContain(`${f.beforeCommit} ${f.captured.capsule.baseCommit}`);
    expect(await git(f.target, "reflog", "show", "--format=%H", "incoming")).toBe(f.captured.capsule.baseCommit);
  });
});
