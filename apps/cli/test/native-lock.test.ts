import { execFile, spawn } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireNativeLock, prepareNativeLock, releaseNativeLock } from "../src/native-lock.js";

const execute = promisify(execFile), temporary: string[] = [];
let bundleRoot: string, bundle: string;
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "statecase-native-lock-bundle-")); bundle = join(bundleRoot, "locks.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/native-lock.ts", import.meta.url))], outfile: bundle, bundle: true,
    platform: "node", format: "esm", target: "node22", logLevel: "silent" });
});
afterAll(async () => { if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true }); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "statecase-native-lock-")); temporary.push(root);
  const repo = join(root, "repo"); await mkdir(repo);
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty-config") } as unknown as NodeJS.ProcessEnv;
  await execute("git", ["-C", repo, "init", "-q", "-b", "main"], { env });
  const directory = join(repo, ".git"), path = join(directory, "index.lock"), grants = [{ root: directory, path }];
  return { root, repo, env, directory, path, options: { grants } };
}
async function child(f: Awaited<ReturnType<typeof fixture>>, script: string) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", `import {prepareNativeLock,acquireNativeLock,releaseNativeLock} from ${JSON.stringify(pathToFileURL(bundle).href)};
    import {readFile,writeFile,open} from 'node:fs/promises';${script}`], { cwd: f.root, env: f.env, stdio: "ignore" });
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 10000);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    proc.once("error", reject); proc.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  expect(timedOut).toBe(false); return result;
}
function applyScript(f: Awaited<ReturnType<typeof fixture>>, phase: string) {
  return `const options=${JSON.stringify(f.options)}; const plan=await prepareNativeLock(${JSON.stringify(f.path)},options);
    const record=await open(${JSON.stringify(join(f.root, "intent.json"))},'wx',0o600);
    try{await record.writeFile(JSON.stringify(plan));await record.sync();}finally{await record.close();}
    const directory=await open(${JSON.stringify(f.root)},'r');try{await directory.sync();}finally{await directory.close();}
    if(${JSON.stringify(phase)}==='intent')process.kill(process.pid,'SIGKILL');
    await acquireNativeLock(plan,{...options,afterBoundary:phase=>{if(phase===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');}});`;
}
describe("persist native Git lock ownership before publication (RT-006, WS-034)", () => {
  it("prepares an owned inode without taking the native lock, then blocks actual Git until guarded release", async () => {
    const f = await fixture(), plan = await prepareNativeLock(f.path, f.options);
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    await acquireNativeLock(plan, f.options);
    await writeFile(join(f.repo, "note"), "synthetic workspace");
    await expect(execute("git", ["-C", f.repo, "add", "note"], { env: f.env })).rejects.toThrow();
    expect((await lstat(f.path)).nlink).toBe(2);
    await releaseNativeLock(plan, f.options);
    await execute("git", ["-C", f.repo, "add", "note"], { env: f.env });
    await releaseNativeLock(plan, f.options);
    await expect(lstat(plan.artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["intent", "link-created", "link-durable"])("a fresh process releases only the recorded lock after death at %s", async phase => {
    const f = await fixture();
    expect(await child(f, applyScript(f, phase))).toEqual({ code: null, signal: "SIGKILL" });
    const script = `const plan=JSON.parse(await readFile(${JSON.stringify(join(f.root, "intent.json"))},'utf8'));await releaseNativeLock(plan,${JSON.stringify(f.options)});`;
    expect(await child(f, script)).toEqual({ code: 0, signal: null });
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(f.directory)).some(name => name.includes("statecase-transaction"))).toBe(false);
    expect(await child(f, script)).toEqual({ code: 0, signal: null });
  });

  it.each(["native-unlinked", "anchor-unlinked", "artifact-removed", "released-durable"])("recovery itself can die at %s and complete idempotently", async phase => {
    const f = await fixture(); await child(f, applyScript(f, "link-durable"));
    const load = `const plan=JSON.parse(await readFile(${JSON.stringify(join(f.root, "intent.json"))},'utf8'));`;
    expect(await child(f, `${load}await releaseNativeLock(plan,{...${JSON.stringify(f.options)},afterBoundary:phase=>{if(phase===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');}});`)).toEqual({ code: null, signal: "SIGKILL" });
    expect(await child(f, `${load}await releaseNativeLock(plan,${JSON.stringify(f.options)});`)).toEqual({ code: 0, signal: null });
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never steals a pre-existing native lock", async () => {
    const f = await fixture(), plan = await prepareNativeLock(f.path, f.options); await writeFile(f.path, "foreign writer");
    await expect(acquireNativeLock(plan, f.options)).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
    await expect(releaseNativeLock(plan, f.options)).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
    expect(await readFile(f.path, "utf8")).toBe("foreign writer");
  });

  it("does not remove a replacement lock with the same bytes but a different inode", async () => {
    const f = await fixture(), plan = await prepareNativeLock(f.path, f.options); await acquireNativeLock(plan, f.options);
    const bytes = await readFile(f.path); await rm(f.path); await writeFile(f.path, bytes, { mode: 0o600 });
    await expect(releaseNativeLock(plan, f.options)).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
    expect(await readFile(f.path)).toEqual(bytes);
    expect((await lstat(join(plan.artifact.path, "anchor"))).nlink).toBe(1);
  });

  it.each(["bytes", "permissions", "extra-link", "unknown-child", "artifact", "parent", "symlink"])("refuses changed %s evidence without removing the native lock", async fault => {
    const f = await fixture(), plan = await prepareNativeLock(f.path, f.options); await acquireNativeLock(plan, f.options);
    if (fault === "bytes") await writeFile(f.path, "independent mutation");
    if (fault === "permissions") await chmod(f.path, 0o644);
    if (fault === "extra-link") await link(f.path, join(f.root, "third-link"));
    if (fault === "unknown-child") await writeFile(join(plan.artifact.path, "foreign"), "unowned");
    if (fault === "artifact") { await rename(plan.artifact.path, `${plan.artifact.path}.retained`); await mkdir(plan.artifact.path, { mode: 0o700 }); }
    if (fault === "parent") { await rename(f.directory, `${f.directory}.retained`); await mkdir(f.directory); await writeFile(f.path, "foreign parent lock"); }
    if (fault === "symlink") { await rm(f.path); await symlink(join(plan.artifact.path, "anchor"), f.path); }
    await expect(releaseNativeLock(plan, f.options)).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
    expect(await lstat(f.path)).toBeDefined();
  });

  it("an inode-shaped descriptor cannot claim ownership of bytes without the exact anchor marker", async () => {
    const f = await fixture(), plan = await prepareNativeLock(f.path, f.options); await acquireNativeLock(plan, f.options);
    await writeFile(f.path, "X".repeat((await readFile(f.path)).length));
    const info = await lstat(f.path, { bigint: true });
    plan.anchorIdentity = [info.dev, info.ino, info.mode, info.uid, info.size, info.mtimeNs].map(String).join(":");
    await expect(releaseNativeLock(plan, f.options)).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
    expect((await readFile(f.path, "utf8")).startsWith("X")).toBe(true);
  });

  it("preview is non-mutating and reacquisition of a proven owned lock is idempotent", async () => {
    const f = await fixture(), plan = await prepareNativeLock(f.path, f.options); await acquireNativeLock(plan, f.options);
    const before = await lstat(f.path); await acquireNativeLock(plan, f.options);
    await releaseNativeLock(plan, { ...f.options, dryRun: true });
    expect((await lstat(f.path)).ino).toBe(before.ino);
    await releaseNativeLock(plan, f.options);
  });

  it("repeated acquisition and release still cross their directory-durable boundaries", async () => {
    const f = await fixture(), plan = await prepareNativeLock(f.path, f.options); await acquireNativeLock(plan, f.options);
    const acquired: string[] = [], released: string[] = [];
    await acquireNativeLock(plan, { ...f.options, afterBoundary: phase => { acquired.push(phase); } });
    expect(acquired).toContain("link-durable");
    await releaseNativeLock(plan, f.options);
    await releaseNativeLock(plan, { ...f.options, afterBoundary: phase => { released.push(phase); } });
    expect(released).toContain("released-durable");
  });

  it.each(["empty", "ungranted", "duplicate", "too-many", "relative-root", "relative-path", "root-target", "outside", "not-lock", "control", "too-long"])("refuses %s grants before allocation", async fault => {
    const f = await fixture(); let grants = f.options.grants;
    if (fault === "empty") grants = [];
    if (fault === "ungranted") grants = [{ root: f.directory, path: join(f.directory, "different.lock") }];
    if (fault === "duplicate") grants = [...grants, ...grants];
    if (fault === "too-many") grants = Array.from({ length: 129 }, (_, i) => ({ root: f.directory, path: join(f.directory, `${i}.lock`) }));
    if (fault === "relative-root") grants = [{ root: "relative", path: f.path }];
    if (fault === "relative-path") grants = [{ root: f.directory, path: "relative.lock" }];
    if (fault === "root-target") grants = [{ root: f.path, path: f.path }];
    if (fault === "outside") grants = [{ root: f.directory, path: join(f.root, "outside.lock") }];
    if (fault === "not-lock") grants = [{ root: f.directory, path: join(f.directory, "credentials") }];
    if (fault === "control") grants = [{ root: f.directory, path: join(f.directory, "\n.lock") }];
    if (fault === "too-long") grants = [{ root: f.directory, path: join(f.directory, `${"x".repeat(4096)}.lock`) }];
    await expect(prepareNativeLock(f.path, { grants })).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
    expect((await readdir(f.directory)).some(name => name.includes("statecase-transaction"))).toBe(false);
  });

  it.each(["version", "id", "root", "path", "artifact-path", "artifact-identity", "anchor", "parents", "extra"])("refuses altered %s descriptors without releasing the native lock", async fault => {
    const f = await fixture(), plan = await prepareNativeLock(f.path, f.options); await acquireNativeLock(plan, f.options);
    const altered = structuredClone(plan);
    if (fault === "version") Object.assign(altered, { version: 999 });
    if (fault === "id") altered.id = "not-a-uuid";
    if (fault === "root") altered.root = f.root;
    if (fault === "path") altered.path = join(f.directory, "different.lock");
    if (fault === "artifact-path") altered.artifact.path = f.root;
    if (fault === "artifact-identity") altered.artifact.identity = "wrong-inode";
    if (fault === "anchor") altered.anchorIdentity = "wrong-anchor";
    if (fault === "parents") altered.parents = [];
    if (fault === "extra") Object.assign(altered, { unexpected: true });
    await expect(releaseNativeLock(altered, f.options)).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
    expect((await lstat(f.path)).nlink).toBe(2);
  });

  it("does not replace an existing private artifact on an allocation collision", async () => {
    const f = await fixture(), plan = await prepareNativeLock(f.path, f.options);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(plan.id as ReturnType<typeof crypto.randomUUID>);
    const bytes = await readFile(join(plan.artifact.path, "anchor"));
    await expect(prepareNativeLock(f.path, f.options)).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
    expect(await readFile(join(plan.artifact.path, "anchor"))).toEqual(bytes);
  });

  it.each(["missing", "symlink", "too-deep"])("does not create or follow %s native parents", async fault => {
    const f = await fixture(); let parent = join(f.directory, "nested");
    if (fault === "symlink") await symlink(f.root, parent);
    if (fault === "too-deep") { parent = join(f.directory, ...Array.from({ length: 64 }, () => "d")); await mkdir(parent, { recursive: true }); }
    const path = join(parent, "index.lock");
    await expect(prepareNativeLock(path, { grants: [{ root: f.directory, path }] })).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
    await expect(lstat(join(f.root, "index.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("handles nested existing native parents and preserves the prepared anchor during preview", async () => {
    const f = await fixture(), parent = join(f.directory, "refs", "heads"); const path = join(parent, "branch.lock"), options = { grants: [{ root: f.directory, path }] };
    const plan = await prepareNativeLock(path, options), before = await readFile(join(plan.artifact.path, "anchor"));
    await releaseNativeLock(plan, { ...options, dryRun: true });
    expect(await readFile(join(plan.artifact.path, "anchor"))).toEqual(before);
    await acquireNativeLock(plan, options); await releaseNativeLock(plan, options);
  });

  it("refuses allocating/acquiring during preview and cannot resurrect a retired descriptor", async () => {
    const f = await fixture();
    await expect(prepareNativeLock(f.path, { ...f.options, dryRun: true })).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
    const plan = await prepareNativeLock(f.path, f.options);
    await expect(acquireNativeLock(plan, { ...f.options, dryRun: true })).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
    await releaseNativeLock(plan, f.options);
    await expect(acquireNativeLock(plan, f.options)).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
  });

  it.each(["missing-anchor", "missing-artifact", "unpublished-extra-link", "owner"])("refuses incomplete %s ownership evidence", async fault => {
    const f = await fixture(), plan = await prepareNativeLock(f.path, f.options);
    if (fault === "unpublished-extra-link") await link(join(plan.artifact.path, "anchor"), join(f.root, "unrecorded-link"));
    else await acquireNativeLock(plan, f.options);
    if (fault === "missing-anchor" || fault === "missing-artifact") await rm(join(plan.artifact.path, "anchor"));
    if (fault === "missing-artifact") await rm(plan.artifact.path, { recursive: true });
    if (fault === "owner") vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    await expect(releaseNativeLock(plan, f.options)).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
  });
  it.each(["link-created", "link-durable", "native-unlinked", "anchor-unlinked", "artifact-removed"] as const)("a caught failure at %s preserves replayable evidence", async boundary => {
    const f = await fixture(), plan = await prepareNativeLock(f.path, f.options), options = { ...f.options,
      afterBoundary: (phase: string) => { if (phase === boundary) throw new Error("injected boundary error"); } };
    if (boundary.startsWith("link-")) await expect(acquireNativeLock(plan, options)).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" });
    else { await acquireNativeLock(plan, f.options); await expect(releaseNativeLock(plan, options)).rejects.toMatchObject({ code: "NATIVE_LOCK_RECOVERY_REQUIRED" }); }
    await releaseNativeLock(plan, f.options);
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
