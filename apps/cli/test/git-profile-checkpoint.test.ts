import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";

const execute = promisify(execFile), temporary: string[] = [];
let bundleRoot: string, bundle: string;
function environment(root: string) {
  return { PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty-config"),
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@statecase.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@statecase.invalid" } as unknown as NodeJS.ProcessEnv;
}
async function git(root: string, ...args: string[]) {
  return (await execute("git", ["-C", root, ...args], { env: environment(root) })).stdout.trim();
}
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "statecase-git-profile-bundle-")); bundle = join(bundleRoot, "config.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/config.ts", import.meta.url))], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    plugins: [{ name: "isolated-native-module", setup(builder) { builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: createRequire(import.meta.url).resolve("better-sqlite3"), external: true })); } }] });
});
afterAll(async () => { await rm(bundleRoot, { recursive: true, force: true }); });
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(linked = false) {
  const root = await mkdtemp(join(tmpdir(), "statecase-git-profile-")); temporary.push(root);
  const main = join(root, "main"), home = join(root, "profile"); await mkdir(main);
  await git(main, "init", "-q", "-b", "main"); await writeFile(join(main, "note"), "original");
  await git(main, "add", "note"); await git(main, "commit", "-qm", "baseline");
  const workspace = linked ? join(root, "linked") : main;
  if (linked) await git(main, "worktree", "add", "-qb", "linked", workspace);
  const indexPath = await git(workspace, "rev-parse", "--path-format=absolute", "--git-path", "index");
  const beforeIndex = await readFile(indexPath);
  await writeFile(join(workspace, "note"), "incoming staged"); await git(workspace, "add", "note");
  const incomingIndex = await readFile(indexPath); await writeFile(indexPath, beforeIndex); await writeFile(join(workspace, "note"), "original");
  await writeFile(join(root, "incoming-index"), incomingIndex);
  const store = new ConfigStore(home), config = await store.loadConfig();
  config.workspaces = [{ id: "project", path: workspace, sync: "git" }]; await store.saveConfig(config);
  return { root, main, home, workspace, indexPath, beforeIndex, incomingIndex, store, original: await readFile(join(home, "config.json"), "utf8") };
}
async function child(f: Awaited<ReturnType<typeof fixture>>, script: string) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", `import {ConfigStore} from ${JSON.stringify(pathToFileURL(bundle).href)}; import {readFile} from "node:fs/promises"; ${script}`], { cwd: f.root, env: environment(f.root), stdio: "ignore" });
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 10000);
  const result = await new Promise((resolve, reject) => { proc.once("error", reject); proc.once("exit", (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
  expect(timedOut).toBe(false); return result;
}
function applyScript(f: Awaited<ReturnType<typeof fixture>>, phase: string, index = -1) {
  return `const store=new ConfigStore(${JSON.stringify(f.home)}),config=await store.loadConfig();
    config.applied.project={revisionId:"incoming",digests:{}};
    await store.materializeConfig(config,{writes:[{path:${JSON.stringify(join(f.workspace, "note"))},bytes:new TextEncoder().encode("incoming worktree")},
      {path:${JSON.stringify(f.indexPath)},bytes:await readFile(${JSON.stringify(join(f.root, "incoming-index"))})}],deletes:[]},
      {workspaceRoots:[${JSON.stringify(f.workspace)}],afterBoundary:(phase,index)=>{if(phase===${JSON.stringify(phase)}&&index===${index})process.kill(process.pid,"SIGKILL");}});`;
}
describe("durable Git index ownership joins the real profile checkpoint (RT-006, WS-034)", () => {
  it.each([false, true])("holds the native writer lock through index/files/profile publication, linked=%s", async linked => {
    const f = await fixture(linked), config = await f.store.loadConfig(); let checked = false;
    config.applied.project = { revisionId: "incoming", digests: {} };
    await f.store.materializeConfig(config, { writes: [{ path: f.indexPath, bytes: f.incomingIndex }], deletes: [] }, {
      workspaceRoots: [f.workspace], afterBoundary: async phase => {
        if (phase !== "install") return;
        const checkpoint = JSON.parse(await readFile(join(f.home, "profile-materialization.json"), "utf8"));
        expect(checkpoint.gitIndexes).toHaveLength(1);
        expect(await lstat(`${f.indexPath}.lock`)).toBeDefined();
        await expect(git(f.workspace, "add", "note")).rejects.toThrow(); checked = true;
      },
    });
    expect(checked).toBe(true); expect(await git(f.workspace, "show", ":note")).toBe("incoming staged");
    await expect(lstat(`${f.indexPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.store.loadConfig()).applied.project.revisionId).toBe("incoming");
    await git(f.workspace, "add", "note");
  });
  it.each([["native-link-created", 0], ["native-link-durable", 0], ["backup", 1], ["install", 1], ["install", 2]] as const)("fresh-process recovery restores index/profile/files after %s/%s", async (phase, index) => {
    const f = await fixture(true);
    expect(await child(f, applyScript(f, phase, index))).toEqual({ code: null, signal: "SIGKILL" });
    const lock = await readFile(`${f.indexPath}.lock`);
    await f.store.recoverMaterialization({ dryRun: true }); expect(await readFile(`${f.indexPath}.lock`)).toEqual(lock);
    expect(await child(f, `await new ConfigStore(${JSON.stringify(f.home)}).recoverMaterialization();`)).toEqual({ code: 0, signal: null });
    expect(await readFile(f.indexPath)).toEqual(f.beforeIndex);
    expect(await readFile(join(f.workspace, "note"), "utf8")).toBe("original");
    expect(await readFile(join(f.home, "config.json"), "utf8")).toBe(f.original);
    await expect(lstat(`${f.indexPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.store.recoverMaterialization()).toMatchObject({ pending: false });
  });
  it.each(["commit", "files-finished", "native-native-unlinked", "native-anchor-unlinked", "native-artifact-removed", "native-released-durable"])("keeps committed state through interrupted cleanup at %s", async phase => {
    const f = await fixture();
    expect(await child(f, applyScript(f, phase, phase.startsWith("native-") ? 0 : -1))).toEqual({ code: null, signal: "SIGKILL" });
    await f.store.recoverMaterialization();
    expect(await readFile(f.indexPath)).toEqual(f.incomingIndex);
    expect(await readFile(join(f.workspace, "note"), "utf8")).toBe("incoming worktree");
    expect((await f.store.loadConfig()).applied.project.revisionId).toBe("incoming");
    expect((await readdir(join(f.main, ".git"))).some(name => name.includes("statecase-transaction"))).toBe(false);
  });
  it("refuses foreign lock replacement before any native or profile rollback", async () => {
    const f = await fixture(); await child(f, applyScript(f, "install", 2));
    await rm(`${f.indexPath}.lock`); await writeFile(`${f.indexPath}.lock`, "foreign writer");
    await expect(f.store.recoverMaterialization()).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    expect(await readFile(f.indexPath)).toEqual(f.incomingIndex);
    expect(await readFile(join(f.home, "config.json"), "utf8")).toContain("incoming");
    expect(await readFile(`${f.indexPath}.lock`, "utf8")).toBe("foreign writer");
  });
  it.each(["unselected", "identity-only", "duplicate"])("refuses %s workspace authority before checkpoint publication", async kind => {
    const f = await fixture(), config = await f.store.loadConfig();
    if (kind === "identity-only") { config.workspaces[0].sync = "identity-only"; await f.store.saveConfig(config); }
    await expect(f.store.materializeConfig(config, { writes: [], deletes: [] }, { workspaceRoots: kind === "unselected" ? [f.root] : kind === "duplicate" ? [f.workspace, f.workspace] : [f.workspace] })).rejects.toThrow();
    await expect(lstat(join(f.home, "profile-materialization.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${f.indexPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("grants the exact index, never sibling Git configuration", async () => {
    const f = await fixture(), config = await f.store.loadConfig(), path = join(f.main, ".git", "config"), before = await readFile(path);
    await expect(f.store.materializeConfig(config, { writes: [{ path, bytes: new Uint8Array([1]) }], deletes: [] }, { workspaceRoots: [f.workspace] })).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
  });
  it.each(["backup", "install"])("does not run caught rollback or the next installation after losing native ownership at %s", async phase => {
    const f = await fixture(), config = await f.store.loadConfig();
    await expect(f.store.materializeConfig(config, { writes: [{ path: f.indexPath, bytes: f.incomingIndex }], deletes: [] }, {
      workspaceRoots: [f.workspace], afterBoundary: async (boundary, index) => {
        if (boundary === phase && index === 0) {
          await rm(`${f.indexPath}.lock`); await writeFile(`${f.indexPath}.lock`, "foreign writer");
          if (phase === "install") throw new Error("caught interruption after ownership loss");
        }
      },
    })).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    if (phase === "backup") await expect(lstat(f.indexPath)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(f.indexPath)).toEqual(f.incomingIndex);
    expect(await readFile(`${f.indexPath}.lock`, "utf8")).toBe("foreign writer");
    await expect(f.store.recoverMaterialization()).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
  });
  it("records every descriptor before publishing any native lock and cancels safely before acquisition", async () => {
    const f = await fixture(true);
    expect(await child(f, applyScript(f, "checkpoint-published"))).toEqual({ code: null, signal: "SIGKILL" });
    const checkpoint = JSON.parse(await readFile(join(f.home, "profile-materialization.json"), "utf8"));
    expect(checkpoint.version).toBe(2); expect(checkpoint.gitIndexes).toHaveLength(1);
    await expect(lstat(`${f.indexPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    await f.store.recoverMaterialization({ dryRun: true });
    await f.store.recoverMaterialization();
    expect(await readFile(f.indexPath)).toEqual(f.beforeIndex);
    await expect(lstat(checkpoint.gitIndexes[0].lock.artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["deleted", "empty", "version", "path"])("refuses %s Git participant metadata without removing a held lock", async kind => {
    const f = await fixture(); await child(f, applyScript(f, "install", 2));
    const path = join(f.home, "profile-materialization.json"), checkpoint = JSON.parse(await readFile(path, "utf8"));
    if (kind === "deleted") delete checkpoint.gitIndexes;
    if (kind === "empty") checkpoint.gitIndexes = [];
    if (kind === "version") checkpoint.version = 1;
    if (kind === "path") checkpoint.gitIndexes[0].lock.path = join(f.home, "foreign.lock");
    await writeFile(path, JSON.stringify(checkpoint), { mode: 0o600 });
    await expect(f.store.recoverMaterialization({ dryRun: true })).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    await expect(f.store.recoverMaterialization()).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    expect(await readFile(f.indexPath)).toEqual(f.incomingIndex);
    expect(await lstat(`${f.indexPath}.lock`)).toBeDefined();
  });
  it("rechecks native ownership during restart rollback before touching the next target", async () => {
    const f = await fixture(); await child(f, applyScript(f, "install", 2));
    await expect(f.store.recoverMaterialization({ afterBoundary: async (phase, index) => {
      if (phase === "rollback" && index === 2) { await rm(`${f.indexPath}.lock`); await writeFile(`${f.indexPath}.lock`, "foreign writer"); }
    } })).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    expect(await readFile(join(f.home, "config.json"), "utf8")).toBe(f.original);
    expect(await readFile(f.indexPath)).toEqual(f.incomingIndex);
    expect(await readFile(join(f.workspace, "note"), "utf8")).toBe("incoming worktree");
    await expect(f.store.loadConfig()).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
  });
  it("validates all repository locks before rolling back either participant", async () => {
    const f = await fixture(true), config = await f.store.loadConfig(), otherIndex = join(f.main, ".git", "index");
    config.workspaces.push({ id: "main", path: f.main, sync: "git" }); await f.store.saveConfig(config);
    let boundary = false;
    await expect(f.store.materializeConfig(config, { writes: [{ path: f.indexPath, bytes: f.incomingIndex }, { path: otherIndex, bytes: f.incomingIndex }], deletes: [] }, {
      workspaceRoots: [f.workspace, f.main], afterBoundary: async (phase, index) => {
        if (phase !== "install" || index !== 0) return;
        boundary = true; await rm(`${otherIndex}.lock`); await writeFile(`${otherIndex}.lock`, "foreign writer"); throw new Error("interrupted");
      },
    })).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    expect(boundary).toBe(true);
    const firstLock = await readFile(`${f.indexPath}.lock`);
    await expect(f.store.recoverMaterialization()).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    expect(await readFile(f.indexPath)).toEqual(f.incomingIndex);
    expect(await readFile(`${f.indexPath}.lock`)).toEqual(firstLock);
  });
  it.each(["symlink", "delete"])("does not grant an index %s operation", async kind => {
    const f = await fixture(), config = await f.store.loadConfig();
    await expect(f.store.materializeConfig(config, { writes: [], deletes: kind === "delete" ? [f.indexPath] : [],
      symlinks: kind === "symlink" ? [{ path: f.indexPath, target: join(f.root, "foreign") }] : [] }, { workspaceRoots: [f.workspace] })).rejects.toThrow();
    expect(await readFile(f.indexPath)).toEqual(f.beforeIndex);
  });
});
