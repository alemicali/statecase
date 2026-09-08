import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { captureWorkspace, withPreparedWorkspaceTransaction } from "../src/index.js";

const execute = promisify(execFile), temporary: string[] = [];
let bundleRoot: string, bundle: string;
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "statecase-workspace-plan-bundle-"));
  bundle = join(bundleRoot, "workspace.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))], outfile: bundle,
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
});
afterAll(async () => { await rm(bundleRoot, { recursive: true, force: true }); });
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function environment(root: string) {
  return { PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty-config"),
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@statecase.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@statecase.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z", GIT_OPTIONAL_LOCKS: "0" } as unknown as NodeJS.ProcessEnv;
}
async function git(root: string, ...args: string[]) {
  return (await execute("git", ["-C", root, ...args], { env: environment(root), encoding: "utf8" })).stdout.trim();
}
async function fixture(shallow = false) {
  const root = await mkdtemp(join(tmpdir(), "statecase-workspace-plan-")); temporary.push(root);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1"); vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "empty-config"));
  const source = join(root, "source"), target = join(root, "target"); await mkdir(source);
  await git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "note"), "baseline"); await git(source, "add", "note"); await git(source, "commit", "-qm", "base");
  await git(root, "clone", "-q", ...(shallow ? ["--depth", "1", `file://${source}`] : ["--no-local", source]), target);
  const oldCommit = await git(target, "rev-parse", "HEAD");
  await writeFile(join(source, "note"), "new baseline"); await git(source, "add", "note"); await git(source, "commit", "-qm", "next");
  await git(source, "switch", "-qc", "incoming");
  await writeFile(join(source, "note"), "staged incoming"); await git(source, "add", "note"); await writeFile(join(source, "note"), "worktree incoming");
  await writeFile(join(source, "new-note"), "untracked incoming");
  // Only the explicitly selected local fixture origin is fetched by preparation.
  const captured = await captureWorkspace(source);
  const beforeIndex = await readFile(join(target, ".git", "index"));
  return { root, source, target, captured, oldCommit, beforeIndex };
}
async function assertOriginal(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await git(f.target, "rev-parse", "HEAD")).toBe(f.oldCommit);
  expect(await git(f.target, "symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(await readFile(join(f.target, ".git", "index"))).toEqual(f.beforeIndex);
  expect(await readFile(join(f.target, "note"), "utf8")).toBe("baseline");
  await expect(lstat(join(f.target, "new-note"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(git(f.target, "rev-parse", "--verify", "refs/heads/incoming")).rejects.toThrow();
}
describe("prepare complete Git participants before native mutation (RT-006, WS-034)", () => {
  it("hands the coordinator an exact staged index and reference plan while the old native state remains intact", async () => {
    const f = await fixture(); let called = false;
    await withPreparedWorkspaceTransaction([{ root: f.target, captured: f.captured, gitFetch: "auto" }], { writes: [], deletes: [] }, async plan => {
      called = true; await assertOriginal(f);
      expect(plan.references).toEqual([{ root: f.target, indexPath: join(f.target, ".git", "index"),
        before: { baseCommit: f.oldCommit, headRef: "main" },
        after: { baseCommit: f.captured.capsule.baseCommit, headRef: "incoming" }, targetOriginalCommit: null }]);
      const index = plan.files.writes.find(write => write.path === join(f.target, ".git", "index"))!;
      expect(index.bytes).toBeInstanceOf(Uint8Array);
      const staged = join(f.root, "inspect-index"); await writeFile(staged, index.bytes!);
      const result = await execute("git", ["-C", f.target, "show", ":note"], { env: { ...environment(f.target), GIT_INDEX_FILE: staged } });
      expect(result.stdout).toBe("staged incoming");
      expect(new TextDecoder().decode(plan.files.writes.find(write => write.path === join(f.target, "note"))!.bytes)).toBe("worktree incoming");
      await plan.guard();
    });
    expect(called).toBe(true); await assertOriginal(f);
    await expect(lstat(join(f.target, ".git", "index.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("process death at the prepared handoff cannot advance HEAD, index or worktree or strand a Git writer lock", async () => {
    const f = await fixture();
    const script = `import {captureWorkspace,withPreparedWorkspaceTransaction} from ${JSON.stringify(pathToFileURL(bundle).href)};
      const captured=await captureWorkspace(${JSON.stringify(f.source)});
      await withPreparedWorkspaceTransaction([{root:${JSON.stringify(f.target)},captured,gitFetch:"auto"}],{writes:[],deletes:[]},async()=>{process.kill(process.pid,"SIGKILL");});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: f.root, env: environment(f.root), stdio: "ignore" });
    let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10000);
    const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
    expect(timedOut).toBe(false); expect(result).toEqual({ code: null, signal: "SIGKILL" });
    await assertOriginal(f);
    await expect(lstat(join(f.target, ".git", "index.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(f.target)).toEqual([".git", "note"]);
  });

  it("callback refusal leaves the old state intact", async () => {
    const f = await fixture();
    await expect(withPreparedWorkspaceTransaction([{ root: f.target, captured: f.captured, gitFetch: "auto" }], { writes: [], deletes: [] }, async () => { throw new Error("durable admission refused"); })).rejects.toThrow("durable admission refused");
    await assertOriginal(f);
  });

  it.each(["worktree", "index", "index-mode", "head", "target-ref", "ref-alias"])("the handoff guard detects a later independent %s change", async kind => {
    const f = await fixture();
    await withPreparedWorkspaceTransaction([{ root: f.target, captured: f.captured, gitFetch: "auto" }], { writes: [], deletes: [] }, async plan => {
      if (kind === "worktree") await writeFile(join(f.target, "note"), "independent work");
      if (kind === "index") { await writeFile(join(f.target, "local"), "local index"); await git(f.target, "add", "local"); }
      if (kind === "index-mode") await chmod(join(f.target, ".git", "index"), 0o700);
      if (kind === "head") await git(f.target, "switch", "-qc", "independent");
      if (kind === "target-ref") await git(f.target, "update-ref", "refs/heads/incoming", f.oldCommit);
      if (kind === "ref-alias") await git(f.target, "symbolic-ref", "refs/heads/incoming", "refs/heads/main");
      await expect(plan.guard()).rejects.toThrow("changed");
    });
    if (kind === "worktree") expect(await readFile(join(f.target, "note"), "utf8")).toBe("independent work");
    if (kind === "target-ref") expect(await git(f.target, "rev-parse", "refs/heads/incoming")).toBe(f.oldCommit);
  });

  it("validates every root and duplicate roots before admitting a plan", async () => {
    const f = await fixture(); let called = false;
    const consume = async () => { called = true; };
    const application = { root: f.target, captured: f.captured, gitFetch: "auto" as const };
    await expect(withPreparedWorkspaceTransaction([application, application], { writes: [], deletes: [] }, consume)).rejects.toThrow("duplicate");
    await expect(withPreparedWorkspaceTransaction([application, { ...application, root: f.root }], { writes: [], deletes: [] }, consume)).rejects.toThrow();
    expect(called).toBe(false); await assertOriginal(f);
    await expect(git(f.target, "cat-file", "-e", `${f.captured.capsule.baseCommit}^{commit}`)).rejects.toThrow();
  });

  it.each(["detached", "existing-branch", "packed-ref", "managed-dirty"])("prepares %s state without changing the original repository", async kind => {
    const f = await fixture();
    if (kind === "detached") f.captured.capsule.headRef = null;
    if (kind === "existing-branch" || kind === "packed-ref") await git(f.target, "branch", "incoming");
    if (kind === "packed-ref") await git(f.target, "pack-refs", "--all");
    if (kind === "managed-dirty") await writeFile(join(f.target, "note"), "previously applied overlay");
    const current = await captureWorkspace(f.target);
    await withPreparedWorkspaceTransaction([{ root: f.target, captured: f.captured, gitFetch: "auto",
      ...(kind === "managed-dirty" ? { expectedCurrent: current } : {}) }], { writes: [], deletes: [] }, async plan => {
      expect(plan.references[0].after.headRef).toBe(kind === "detached" ? null : "incoming");
      expect(plan.references[0].targetOriginalCommit).toBe(kind === "existing-branch" || kind === "packed-ref" ? f.oldCommit : null);
      await plan.guard();
    });
    expect(await captureWorkspace(f.target)).toEqual(current);
    expect(await readFile(join(f.target, ".git", "index"))).toEqual(f.beforeIndex);
  });

  it("prepares an unborn source and destination with an absent native index", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-workspace-plan-unborn-")); temporary.push(root);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1"); vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "empty-config"));
    const source = join(root, "source"), target = join(root, "target"); await mkdir(source); await mkdir(target);
    await git(source, "init", "-q", "-b", "incoming"); await git(target, "init", "-q", "-b", "main");
    await writeFile(join(source, "note"), "first staged file"); await git(source, "add", "note");
    const captured = await captureWorkspace(source);
    await withPreparedWorkspaceTransaction([{ root: target, captured }], { writes: [], deletes: [] }, async plan => {
      expect(plan.references[0]).toMatchObject({ before: { baseCommit: null, headRef: "main" }, after: { baseCommit: null, headRef: "incoming" }, targetOriginalCommit: null });
      await plan.guard();
    });
    await expect(lstat(join(target, ".git", "index"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(target, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  it("hands off all roots together and preserves the caller's immediate per-file guard", async () => {
    const a = await fixture(), b = await fixture(); let guarded = 0;
    const path = join(a.root, "ordinary");
    await withPreparedWorkspaceTransaction([a, b].map(f => ({ root: f.target, captured: f.captured, gitFetch: "auto" })),
      { writes: [{ path, bytes: new Uint8Array([1]) }], deletes: [], beforeCommit: () => { guarded++; } }, async plan => {
        expect(plan.references.map(ref => ref.root)).toEqual([a.target, b.target]);
        await plan.guard(); await plan.files.beforeCommit!(0, path); expect(guarded).toBe(1);
        await writeFile(join(a.target, "note"), "late editor change");
        await expect(plan.files.beforeCommit!(1, join(a.target, "note"))).rejects.toThrow("changed");
      });
    await assertOriginal(b);
  });

  it("records the actual worktree-specific index path for a linked Git worktree", async () => {
    const f = await fixture(); const linked = join(f.root, "linked");
    await git(f.target, "worktree", "add", "--detach", linked, f.oldCommit);
    const index = await git(linked, "rev-parse", "--git-path", "index"), original = await readFile(index);
    await withPreparedWorkspaceTransaction([{ root: linked, captured: f.captured, gitFetch: "auto" }], { writes: [], deletes: [] }, async plan => {
      expect(plan.references[0]).toMatchObject({ root: linked, indexPath: index, before: { baseCommit: f.oldCommit, headRef: null } });
      expect(plan.files.writes.some(write => write.path === index)).toBe(true); await plan.guard();
    });
    expect(await readFile(index)).toEqual(original); expect(await git(linked, "rev-parse", "HEAD")).toBe(f.oldCommit);
  });

  it("can hand off ordinary files when no workspace participates", async () => {
    let called = false;
    await withPreparedWorkspaceTransaction([], { writes: [], deletes: [] }, async plan => {
      called = true; expect(plan.references).toEqual([]); expect(plan.files.writes).toEqual([]); await plan.guard();
    });
    expect(called).toBe(true);
  });

  it.each([false, true])("rechecks newly acquired baseline gitlinks before handoff (existing directory=%s)", async initialized => {
    const f = await fixture();
    await git(f.source, "update-index", "--add", "--cacheinfo", `160000,${f.oldCommit},module`);
    await git(f.source, "commit", "-qm", "gitlink baseline");
    const captured = await captureWorkspace(f.source);
    if (initialized) {
      await writeFile(join(f.target, ".git", "info", "exclude"), "module/\n");
      await mkdir(join(f.target, "module")); await writeFile(join(f.target, "module", "local-note"), "unselected submodule work");
    }
    let called = false;
    const action = withPreparedWorkspaceTransaction([{ root: f.target, captured, gitFetch: "auto", expectedCurrent: await captureWorkspace(f.target) }],
      { writes: [], deletes: [] }, async plan => {
        called = true; expect(plan.files.writes.some(write => write.path === join(f.target, "module"))).toBe(false); await plan.guard();
      });
    if (initialized) {
      await expect(action).rejects.toThrow("initialized submodule"); expect(called).toBe(false);
      expect(await readFile(join(f.target, "module", "local-note"), "utf8")).toBe("unselected submodule work");
    } else { await action; expect(called).toBe(true); }
    await assertOriginal(f);
  });

  it("retains an explicit uninitialized gitlink record without treating it as ordinary file content", async () => {
    const f = await fixture();
    f.captured.capsule.records.push({ path: "module", index: { state: "submodule", mode: 0o160000, oid: f.oldCommit }, worktree: { state: "submodule" } });
    await withPreparedWorkspaceTransaction([{ root: f.target, captured: f.captured, gitFetch: "auto" }], { writes: [], deletes: [] }, async plan => {
      expect([...plan.files.writes.map(write => write.path), ...plan.files.deletes]).not.toContain(join(f.target, "module")); await plan.guard();
    });
    await assertOriginal(f);
  });

  it("rejects duplicate native targets before the consumer can publish a Git intent", async () => {
    const f = await fixture(); let called = false;
    await expect(withPreparedWorkspaceTransaction([{ root: f.target, captured: f.captured, gitFetch: "auto" }],
      { writes: [{ path: join(f.target, "note"), bytes: new Uint8Array([1]) }], deletes: [] }, async () => { called = true; })).rejects.toThrow("duplicate");
    expect(called).toBe(false); await assertOriginal(f);
  });

  it("a native index writer already holding its lock prevents handoff without stealing the lock", async () => {
    const f = await fixture(); const lock = join(f.target, ".git", "index.lock"); await writeFile(lock, "other writer"); let called = false;
    await expect(withPreparedWorkspaceTransaction([{ root: f.target, captured: f.captured, gitFetch: "auto" }], { writes: [], deletes: [] }, async () => { called = true; })).rejects.toThrow("writer");
    expect(called).toBe(false); expect(await readFile(lock, "utf8")).toBe("other writer"); await assertOriginal(f);
  });

  it.each(["ask", "never"] as const)("retains the baseline acquisition policy %s without calling the consumer", async gitFetch => {
    const f = await fixture(); let called = false;
    await expect(withPreparedWorkspaceTransaction([{ root: f.target, captured: f.captured, gitFetch }], { writes: [], deletes: [] }, async () => { called = true; })).rejects.toMatchObject({ code: "BASELINE_UNAVAILABLE" });
    expect(called).toBe(false); await assertOriginal(f);
  });

  it.each(["full", "shallow", "many-branches"])("fallback acquisition (%s) cannot apply configured refspecs or overwrite FETCH_HEAD before durable intent", async kind => {
    const f = await fixture(kind === "shallow");
    if (kind === "many-branches") for (let index = 0; index < 65; index++) await git(f.source, "update-ref", `refs/heads/a/${String(index).padStart(3, "0")}`, f.oldCommit);
    await git(f.target, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");
    const fetchHead = join(f.target, ".git", "FETCH_HEAD"); await writeFile(fetchHead, "pre-existing fetch metadata\n");
    const bin = join(f.root, "bin"); await mkdir(bin);
    await writeFile(join(bin, "git"), `#!${process.execPath}\nimport{spawnSync}from'node:child_process';const args=process.argv.slice(2);
      if(args.includes('fetch')&&args.at(-1)===${JSON.stringify(f.captured.capsule.baseCommit)})process.exit(1);
      const result=spawnSync('git',args,{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(process.env.PATH)}}});process.exit(result.status??1);`, { mode: 0o700 });
    await writeFile(join(bin, "package.json"), '{"type":"module"}'); vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    let called = false;
    await withPreparedWorkspaceTransaction([{ root: f.target, captured: f.captured, gitFetch: "auto" }], { writes: [], deletes: [] }, async plan => {
      called = true; await plan.guard();
    });
    expect(called).toBe(true); await assertOriginal(f);
    expect(await readFile(fetchHead, "utf8")).toBe("pre-existing fetch metadata\n");
  }, 30000); // Real Git plus a process-level fault proxy under concurrent V8 coverage.

  it.each(["advertisement-error", "empty", "malformed", "fetch-error"])("failed preparation acquisition (%s) leaves operational state untouched", async fault => {
    const f = await fixture(); const bin = join(f.root, "bin"); await mkdir(bin);
    await writeFile(join(bin, "git"), `#!${process.execPath}\nimport{spawnSync}from'node:child_process';const args=process.argv.slice(2);
      if(args.includes('fetch')&&(args.at(-1)===${JSON.stringify(f.captured.capsule.baseCommit)}||${fault === "fetch-error"}))process.exit(1);
      if(args.includes('ls-remote')&&${fault !== "fetch-error"}){${fault === "malformed" ? "process.stdout.write('invalid\\trefs/heads/main\\n');" : ""}process.exit(${fault === "advertisement-error" ? 128 : 0});}
      const result=spawnSync('git',args,{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(process.env.PATH)}}});process.exit(result.status??1);`, { mode: 0o700 });
    await writeFile(join(bin, "package.json"), '{"type":"module"}'); vi.stubEnv("PATH", `${bin}:${process.env.PATH}`); let called = false;
    await expect(withPreparedWorkspaceTransaction([{ root: f.target, captured: f.captured, gitFetch: "auto" }], { writes: [], deletes: [] }, async () => { called = true; })).rejects.toMatchObject({ code: "BASELINE_UNAVAILABLE" });
    expect(called).toBe(false); await assertOriginal(f);
  }, 30000);

  it.each(["symbolic-error", "oid-error", "invalid-oid"])("refuses %s from Git during revalidation instead of treating it as absence", async fault => {
    const f = await fixture();
    await withPreparedWorkspaceTransaction([{ root: f.target, captured: f.captured, gitFetch: "auto" }], { writes: [], deletes: [] }, async plan => {
      const bin = join(f.root, "bin"); await mkdir(bin);
      const wrapper = `#!${process.execPath}\nimport{spawnSync}from'node:child_process';const args=process.argv.slice(2);
        if(args.includes('refs/heads/incoming')&&args.includes(${JSON.stringify(fault === "symbolic-error" ? "symbolic-ref" : "rev-parse")})){
          ${fault === "invalid-oid" ? "process.stdout.write('invalid-object-id\\n');process.exit(0);" : "process.exit(128);"}}
        const result=spawnSync('git',args,{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(process.env.PATH)}}});process.exit(result.status??1);`;
      await writeFile(join(bin, "git"), wrapper, { mode: 0o700 }); await writeFile(join(bin, "package.json"), '{"type":"module"}');
      vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
      await expect(plan.guard()).rejects.toThrow(/safely|invalid/u);
    });
  }, 30000);
});
