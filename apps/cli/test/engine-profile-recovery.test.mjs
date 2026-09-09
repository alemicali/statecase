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

const execute = promisify(execFile), roots = [];
let bundleRoot, bundle;
function environment(root) {
  return { PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty-config"), GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@statecase.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@statecase.invalid" };
}
async function git(root, ...args) { return (await execute("git", ["-C", root, ...args], { env: environment(root) })).stdout.trim(); }
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "statecase-engine-recovery-bundle-")); bundle = join(bundleRoot, "engine.mjs");
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const exports = [
    ["ConfigStore", "apps/cli/src/config.ts"], ["StatecaseClient", "apps/cli/src/client.ts"], ["SyncEngine", "apps/cli/src/sync.ts"],
    ["randomKey", "packages/crypto/src/index.ts"], ["referenceTransport", "scripts/uat/native-reference.mjs"],
  ].map(([name, path]) => `export {${name}} from ${JSON.stringify(join(repository, path))};`).join("\n");
  await build({ stdin: { contents: exports, resolveDir: repository, loader: "ts" }, outfile: bundle, bundle: true,
    platform: "node", format: "esm", target: "node22", logLevel: "silent",
    plugins: [{ name: "isolated-native-module", setup(builder) {
      builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: createRequire(import.meta.url).resolve("better-sqlite3"), external: true }));
    } }] });
});
afterAll(async () => { await rm(bundleRoot, { recursive: true, force: true }); });
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "statecase-engine-recovery-"))); roots.push(root);
  for (const key of ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_OPTIONAL_LOCKS"]) vi.stubEnv(key, environment(root)[key]);
  const source = join(root, "source"), target = join(root, "target"), home = join(root, "profile"); await mkdir(source);
  await git(source, "init", "-q", "-b", "main"); await writeFile(join(source, "note"), "baseline"); await git(source, "add", "note"); await git(source, "commit", "-qm", "baseline");
  await git(root, "clone", "-q", "--no-local", source, target);
  await git(source, "switch", "-qc", "incoming"); await writeFile(join(source, "note"), "incoming baseline"); await git(source, "commit", "-qam", "incoming");
  await writeFile(join(source, "note"), "incoming staged"); await git(source, "add", "note"); await writeFile(join(source, "note"), "incoming worktree");
  const sourceHarness = join(root, "source-harness"), targetHarness = join(root, "target-harness"), sourceDrop = join(root, "source-drop"), targetDrop = join(root, "target-drop");
  await mkdir(join(sourceHarness, "sessions"), { recursive: true }); for (const path of [targetHarness, sourceDrop, targetDrop]) await mkdir(path);
  await writeFile(join(sourceHarness, "sessions", "native.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd: source } }) + "\n");
  await writeFile(join(sourceDrop, "brief.md"), "synthetic encrypted context canary"); await writeFile(join(targetDrop, "local-only.md"), "untouched local work");
  const configuration = (workspace, harness, drop) => ({ version: 1, apiUrl: "https://fixture.invalid", selectedVaultId: "vlt_fixture", applied: {}, sessionBindings: {},
    mappings: [{ id: "codex", name: "Codex", kind: "codex", namespace: "harness:codex:default", mode: "two-way", path: harness },
      { id: "context", name: "Context", kind: "drop", namespace: "drop:context", mode: "two-way", path: drop }],
    workspaces: [{ id: "project", path: workspace, sync: "git", gitFetch: "auto" }] });
  const store = new ConfigStore(home), config = await store.loadConfig(); Object.assign(config, configuration(target, targetHarness, targetDrop)); await store.saveConfig(config);
  return { root, source, target, home, targetHarness, targetDrop, store, sourceConfig: configuration(source, sourceHarness, sourceDrop),
    before: await readFile(join(home, "config.json")), beforeCapsule: (await captureWorkspace(target)).capsule, beforeIndex: await readFile(join(target, ".git", "index")),
    desiredCapsule: (await captureWorkspace(source)).capsule };
}
async function child(f, script) {
  const code = `import {ConfigStore,SyncEngine,StatecaseClient,randomKey,referenceTransport} from ${JSON.stringify(pathToFileURL(bundle).href)};
    import {readFile,writeFile} from "node:fs/promises"; ${script}`;
  const proc = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: f.root, env: environment(f.root), stdio: "ignore" });
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 15_000);
  const result = await new Promise((resolve, reject) => { proc.once("error", reject); proc.once("exit", (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
  expect(timedOut).toBe(false); return result;
}
function operation(f, phase, target) {
  const paths = { workspace: join(f.target, "note"), HEAD: join(f.target, ".git", "HEAD"), profile: join(f.home, "config.json") };
  return `const transport=referenceTransport("synthetic encrypted context canary"),key=await randomKey(),client=new StatecaseClient("https://fixture.invalid","synthetic-token",transport.fetch);
    await new SyncEngine(client,"vlt_fixture",key).push(${JSON.stringify(f.sourceConfig)});
    const store=new ConfigStore(${JSON.stringify(f.home)}),config=await store.loadConfig();
    const engine=new SyncEngine(client,"vlt_fixture",key,{commitMaterialization:async(proposal,workspaces,files)=>{
      await writeFile(${JSON.stringify(join(f.root, "expected-profile.json"))},JSON.stringify(proposal));
      await store.materializeWorkspaceConfig(proposal,workspaces,files,{afterBoundary:async(phase,index)=>{
        if(phase!==${JSON.stringify(phase)})return;
        ${target ? `const plan=JSON.parse((await readFile(${JSON.stringify(join(f.home, "materialization", "active.jsonl"))},"utf8")).split(String.fromCharCode(10))[0]);
          if(!(${target === "session" ? 'plan.targets[index]?.path.endsWith("/native.jsonl")' : `plan.targets[index]?.path===${JSON.stringify(paths[target])}`}))return;` : ""}
        process.kill(process.pid,"SIGKILL");
      }});
    }});await engine.pull(config);`;
}

describe("encrypted engine pull survives actual process death with a paired native/profile decision (RT-006, WS-034)", () => {
  it.each([
    ["install", "session", "rollback"], ["install", "workspace", "rollback"], ["install", "HEAD", "rollback"], ["install", "profile", "rollback"],
    ["commit", null, "cleanup"], ["retention-removed", null, "cleanup"],
  ])("recovers after %s at %s", async (phase, target, outcome) => {
    const f = await fixture();
    expect(await child(f, operation(f, phase, target))).toEqual({ code: null, signal: "SIGKILL" });
    await expect(f.store.loadConfig()).rejects.toMatchObject({ code: "PROFILE_RECOVERY_REQUIRED" });
    expect(await f.store.recoverProfile({ dryRun: true })).toMatchObject({ pending: true, recovered: false, outcome });
    expect(await child(f, `const result=await new ConfigStore(${JSON.stringify(f.home)}).recoverProfile({dryRun:false,processTable:async()=>""});
      if(result.pending||!result.recovered)throw new Error("operator recovery did not complete");`)).toEqual({ code: 0, signal: null });
    const config = await f.store.loadConfig();
    if (outcome === "rollback") {
      expect(await readFile(join(f.home, "config.json"))).toEqual(f.before);
      expect(await readFile(join(f.target, ".git", "index"))).toEqual(f.beforeIndex);
      expect((await captureWorkspace(f.target)).capsule).toEqual(f.beforeCapsule);
      await expect(readFile(join(f.targetDrop, "brief.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(config).toEqual(JSON.parse(await readFile(join(f.root, "expected-profile.json"), "utf8")));
      expect((await captureWorkspace(f.target)).capsule).toEqual(f.desiredCapsule);
      expect(await readFile(join(f.targetDrop, "brief.md"), "utf8")).toBe("synthetic encrypted context canary");
      expect(Object.keys(config.applied).sort()).toEqual(["drop:context", "harness:codex:default", "workspace:project"]);
      const relativePath = Object.values(config.sessionBindings)[0];
      expect(await readFile(join(f.targetHarness, relativePath), "utf8")).toContain(f.target);
    }
    expect(await readFile(join(f.targetDrop, "local-only.md"), "utf8")).toBe("untouched local work");
    expect(await f.store.recoverMaterialization()).toMatchObject({ pending: false });
    await git(f.target, "add", "note");
  }, 20_000);
});
