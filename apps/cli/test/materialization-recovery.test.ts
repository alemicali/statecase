import { spawn } from "node:child_process";
import { appendFile, chmod, link, lstat, mkdir, mkdtemp, open, readFile, readlink, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyRecoverableFileTransaction, recoverFileTransactions } from "../src/materialization-recovery.js";

const temporary: string[] = [];
let bundleRoot: string, bundle: string;
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "statecase-recovery-bundle-"));
  bundle = join(bundleRoot, "recovery.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/materialization-recovery.ts", import.meta.url))], outfile: bundle,
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    plugins: [{ name: "isolated-native-module", setup(builder) {
      builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: createRequire(import.meta.url).resolve("better-sqlite3"), external: true }));
    } }],
  });
});
afterAll(async () => { if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true }); });
afterEach(async () => { await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "statecase-durable-recovery-")); temporary.push(root);
  const files = join(root, "files"), directory = join(root, "profile", "materialization");
  await mkdir(files); await writeFile(join(files, "first"), "first original"); await writeFile(join(files, "second"), "second original");
  return { root, files, options: { directory, roots: [files] } };
}
async function child(script: string, root: string) {
  const processChild = spawn(process.execPath, ["--input-type=module", "-e", `import { applyRecoverableFileTransaction, recoverFileTransactions } from ${JSON.stringify(pathToFileURL(bundle).href)}; ${script}`], {
    cwd: root, stdio: "ignore",
    env: { HOME: root, STATECASE_HOME: join(root, "profile"), CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude") } as unknown as NodeJS.ProcessEnv,
  });
  let timeout = false;
  const timer = setTimeout(() => { timeout = true; processChild.kill("SIGKILL"); }, 10_000);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    processChild.once("error", reject); processChild.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  expect(timeout).toBe(false);
  return result;
}
function applyScript(files: string, options: unknown, boundary: string, index: number) {
  return `await applyRecoverableFileTransaction({ writes: ${JSON.stringify([join(files, "first"), join(files, "second")])}.map(path => ({path,bytes:new TextEncoder().encode("incoming")})), deletes: [] },
    {...${JSON.stringify(options)}, afterBoundary: (phase,index) => { if (phase === ${JSON.stringify(boundary)} && index === ${index}) process.kill(process.pid,"SIGKILL"); }});`;
}

describe("persistent file materialization replay (RT-006, BK-009)", () => {
  it.each(["intent", "backup", "install"])("a fresh process rolls back after SIGKILL at %s, then replay is a no-op", async (phase) => {
    const { root, files, options } = await fixture();
    expect(await child(applyScript(files, options, phase, 1), root)).toEqual({ code: null, signal: "SIGKILL" });
    expect(await readFile(join(files, "first"), "utf8")).toBe("incoming");
    expect(await child(`await recoverFileTransactions(${JSON.stringify(options)});`, root)).toEqual({ code: 0, signal: null });
    expect(await readFile(join(files, "first"), "utf8")).toBe("first original");
    expect(await readFile(join(files, "second"), "utf8")).toBe("second original");
    expect(await recoverFileTransactions(options)).toMatchObject({ pending: false, outcome: "none" });
    expect((await readdir(files)).sort()).toEqual(["first", "second"]);
  });

  it("previews without mutation and preserves independent post-crash edits and recovery bytes", async () => {
    const { root, files, options } = await fixture();
    expect(await child(applyScript(files, options, "install", 0), root)).toEqual({ code: null, signal: "SIGKILL" });
    expect(await recoverFileTransactions({ ...options, dryRun: true })).toMatchObject({ pending: true, outcome: "rollback" });
    expect(await readFile(join(files, "first"), "utf8")).toBe("incoming");
    await writeFile(join(files, "first"), "independent editor work");
    await expect(recoverFileTransactions(options)).rejects.toThrow("recovery");
    expect(await readFile(join(files, "first"), "utf8")).toBe("independent editor work");
    const artifacts = (await readdir(files)).filter((name) => name.includes(".statecase-transaction-"));
    expect(await readFile(join(files, artifacts.find((name) => name.startsWith("first."))!, "backup"), "utf8")).toBe("first original");
    await expect(applyRecoverableFileTransaction({ writes: [], deletes: [] }, options)).rejects.toThrow("recovery");
  });

  it("normal completion retains installed files and leaves no pending recovery", async () => {
    const { files, options } = await fixture();
    await applyRecoverableFileTransaction({ writes: [{ path: join(files, "first"), bytes: new TextEncoder().encode("new") }], deletes: [join(files, "second")] }, options);
    expect(await readFile(join(files, "first"), "utf8")).toBe("new");
    expect(await readdir(files)).toEqual(["first"]);
    expect(await recoverFileTransactions(options)).toMatchObject({ pending: false });
  });

  it.each(["relative","journal-child","journal-parent","too-many"])("refuses %s exact-file grants before mutation",async kind=>{
    const {root,files,options}=await fixture();
    const granted=kind==="relative"?["relative"]:kind==="journal-child"?[join(options.directory,"active.jsonl")]:kind==="journal-parent"?[root]:Array.from({length:129},(_,index)=>join(root,`metadata-${index}`));
    await expect(applyRecoverableFileTransaction({writes:[{path:join(files,"first"),bytes:new Uint8Array([1])}],deletes:[]},{...options,files:granted})).rejects.toThrow("recovery");
    expect(await readFile(join(files,"first"),"utf8")).toBe("first original");
  });

  it("a persisted commit survives process death and recovery only cleans backups", async () => {
    const { root, files, options } = await fixture();
    expect(await child(applyScript(files, options, "commit", -1), root)).toEqual({ code: null, signal: "SIGKILL" });
    await writeFile(join(files, "first"), "new work after committed installation");
    expect(await recoverFileTransactions({ ...options, dryRun: true })).toMatchObject({ outcome: "cleanup" });
    expect(await child(`await recoverFileTransactions(${JSON.stringify(options)});`, root)).toEqual({ code: 0, signal: null });
    expect(await readFile(join(files, "first"), "utf8")).toBe("new work after committed installation");
    expect(await readFile(join(files, "second"), "utf8")).toBe("incoming");
    expect((await readdir(files)).sort()).toEqual(["first", "second"]);
  });

  it.each(["rollback", "cleanup"])("recovery itself can die at %s and replay again", async (phase) => {
    const { root, files, options } = await fixture();
    expect(await child(applyScript(files, options, "install", 1), root)).toEqual({ code: null, signal: "SIGKILL" });
    expect(await child(`await recoverFileTransactions({...${JSON.stringify(options)}, afterBoundary: (phase,index) => { if (phase === ${JSON.stringify(phase)} && index === 1) process.kill(process.pid,"SIGKILL"); }});`, root)).toEqual({ code: null, signal: "SIGKILL" });
    expect(await recoverFileTransactions(options)).toMatchObject({ outcome: "rollback" });
    expect(await readFile(join(files, "first"), "utf8")).toBe("first original");
    expect(await readFile(join(files, "second"), "utf8")).toBe("second original");
    expect(await recoverFileTransactions(options)).toMatchObject({ pending: false });
  });

  it.each(["create", "delete", "symlink"])("rolls back %s in a fresh process without dereferencing links", async (kind) => {
    const { root, files, options } = await fixture();
    const path = join(files, kind === "create" ? "created" : "first");
    if (kind === "symlink") { await rm(path); await symlink("second", path); }
    const transaction = kind === "delete" ? `{writes:[],deletes:[${JSON.stringify(path)}]}`
      : kind === "symlink" ? `{writes:[],deletes:[],symlinks:[{path:${JSON.stringify(path)},target:"new-target"}]}`
      : `{writes:[{path:${JSON.stringify(path)},bytes:new TextEncoder().encode("created")}],deletes:[]}`;
    expect(await child(`await applyRecoverableFileTransaction(${transaction}, {...${JSON.stringify(options)},afterBoundary:(phase,index)=>{if(phase==="install"&&index===0)process.kill(process.pid,"SIGKILL");}});`, root)).toEqual({ code: null, signal: "SIGKILL" });
    await recoverFileTransactions(options);
    if (kind === "create") await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    if (kind === "delete") expect(await readFile(path, "utf8")).toBe("first original");
    if (kind === "symlink") expect(await readlink(path)).toBe("second");
    expect(await readFile(join(files, "second"), "utf8")).toBe("second original");
  });

  it("a caught failure rolls back files and clears its durable intent", async () => {
    const { files, options } = await fixture();
    await expect(applyRecoverableFileTransaction({ writes: ["first", "second"].map((name) => ({path:join(files,name),bytes:new Uint8Array([1])})), deletes: [],
      beforeCommit: (index) => { if (index === 1) throw new Error("injected guard failure"); },
    }, options)).rejects.toThrow("injected guard failure");
    expect(await readFile(join(files, "first"), "utf8")).toBe("first original");
    expect(await recoverFileTransactions(options)).toMatchObject({ pending: false });
  });

  it("reclaims a completely published preparation without touching native originals", async () => {
    const {root,files,options}=await fixture();
    expect(await child(applyScript(files,options,"prepared",-1),root)).toEqual({code:null,signal:"SIGKILL"});
    expect(await recoverFileTransactions(options)).toMatchObject({outcome:"rollback",targets:2});
    expect(await readFile(join(files,"first"),"utf8")).toBe("first original");
    expect((await readdir(files)).sort()).toEqual(["first","second"]);
  });

  it("does not create missing deletion parents or overwrite independently created no-op targets", async () => {
    const {files,options}=await fixture(), missing=join(files,"missing","target");
    await applyRecoverableFileTransaction({writes:[],deletes:[missing]},options);
    await expect(lstat(join(files,"missing"))).rejects.toMatchObject({code:"ENOENT"});
    await applyRecoverableFileTransaction({writes:[],deletes:[]},options);
    expect(await recoverFileTransactions(options)).toMatchObject({pending:false});
  });

  it("serializes independent recoverers against an active materializer", async () => {
    const {files,options}=await fixture();
    let blocked=false;
    await applyRecoverableFileTransaction({writes:[{path:join(files,"first"),bytes:new Uint8Array([1])}],deletes:[]}, {
      ...options,afterBoundary:async phase=>{if(phase==="prepared"){
        await expect(recoverFileTransactions(options)).rejects.toThrow("recovery");blocked=true;
      }},
    });
    expect(blocked).toBe(true);
    expect(await recoverFileTransactions(options)).toMatchObject({pending:false});
  });

  it.each(["public", "symlink"])("refuses a %s journal directory before any native staging",async kind=>{
    const {root,files,options}=await fixture();
    await mkdir(join(root,"profile"),{mode:0o700});
    if(kind==="public"){await mkdir(options.directory);await chmod(options.directory,0o755);}
    else await symlink(files,options.directory);
    await expect(applyRecoverableFileTransaction({writes:[{path:join(files,"first"),bytes:new Uint8Array([1])}],deletes:[]},options)).rejects.toThrow("recovery");
    expect((await readdir(files)).sort()).toEqual(["first","second"]);
  });

  it("rejects a symlink selected root before creating even a staging artifact",async()=>{
    const {root,files,options}=await fixture(), alias=join(root,"alias");
    await symlink(files,alias);
    await expect(applyRecoverableFileTransaction({writes:[{path:join(alias,"first"),bytes:new Uint8Array([1])}],deletes:[]},{...options,roots:[alias]})).rejects.toThrow("recovery");
    expect((await readdir(files)).sort()).toEqual(["first","second"]);
  });

  it("a replay spanning independent roots restores all originals",async()=>{
    const {root,files,options}=await fixture(), other=join(root,"other");
    await mkdir(other);await writeFile(join(other,"second"),"other original");
    const configured={...options,roots:[files,other]};
    const script=`await applyRecoverableFileTransaction({writes:${JSON.stringify([join(files,"first"),join(other,"second")])}.map(path=>({path,bytes:new TextEncoder().encode("incoming")})),deletes:[]},{...${JSON.stringify(configured)},afterBoundary:(phase,index)=>{if(phase==="install"&&index===1)process.kill(process.pid,"SIGKILL");}});`;
    expect(await child(script,root)).toEqual({code:null,signal:"SIGKILL"});
    await recoverFileTransactions(configured);
    expect(await readFile(join(files,"first"),"utf8")).toBe("first original");
    expect(await readFile(join(other,"second"),"utf8")).toBe("other original");
  });

  it("keeps the committed journal and changed backup instead of deleting a late original-descriptor write",async()=>{
    const {files,options}=await fixture();
    const descriptor=await open(join(files,"first"),"r+");
    try {
      await expect(applyRecoverableFileTransaction({writes:[{path:join(files,"first"),bytes:new TextEncoder().encode("incoming")}],deletes:[]},{...options,
        afterBoundary:async phase=>{if(phase==="commit"){
          await descriptor.truncate(0);await descriptor.writeFile("late original work");await descriptor.sync();
        }},
      })).rejects.toThrow("recovery");
      expect(await readFile(join(files,"first"),"utf8")).toBe("incoming");
      const artifact=(await readdir(files)).find(name=>name.startsWith("first.statecase-"))!;
      expect(await readFile(join(files,artifact,"backup"),"utf8")).toBe("late original work");
      await expect(recoverFileTransactions(options)).rejects.toThrow("recovery");
    } finally {await descriptor.close();}
  });

  it.each(["prepared","intent","backup","install"])("a caught %s boundary failure performs durable rollback",async boundary=>{
    const {files,options}=await fixture();
    await expect(applyRecoverableFileTransaction({writes:[{path:join(files,"first"),bytes:new Uint8Array([1])}],deletes:[]},{...options,
      afterBoundary:phase=>{if(phase===boundary)throw new Error("injected materialization failure");},
    })).rejects.toThrow("injected materialization failure");
    expect(await readFile(join(files,"first"),"utf8")).toBe("first original");
    expect(await recoverFileTransactions(options)).toMatchObject({pending:false});
  });

  it("does not roll back after a commit acknowledgement failure",async()=>{
    const {files,options}=await fixture();
    await expect(applyRecoverableFileTransaction({writes:[{path:join(files,"first"),bytes:new TextEncoder().encode("committed")}],deletes:[]},{...options,
      afterBoundary:phase=>{if(phase==="commit")throw new Error("injected commit acknowledgement failure");},
    })).rejects.toThrow("injected commit acknowledgement failure");
    expect(await readFile(join(files,"first"),"utf8")).toBe("committed");
    expect(await recoverFileTransactions(options)).toMatchObject({outcome:"cleanup"});
    expect(await readFile(join(files,"first"),"utf8")).toBe("committed");
  });

  it.each(["escaped", "root", "relative", "noncanonical", "overlap", "no-roots", "dry-apply"])("rejects %s authority before staging", async (kind) => {
    const { root, files, options } = await fixture();
    const path = kind === "escaped" ? join(root, "outside") : kind === "root" ? files : kind === "relative" ? "first" : kind === "noncanonical" ? `${files}/nested/../first` : join(files,"first");
    const configured = kind === "overlap" ? {...options,directory:join(files,"journal")} : kind === "no-roots" ? {...options,roots:[]} : kind === "dry-apply" ? {...options,dryRun:true} : options;
    await expect(applyRecoverableFileTransaction({writes:[{path,bytes:new Uint8Array([1])}],deletes:[]},configured)).rejects.toThrow("recovery");
    expect((await readdir(files)).sort()).toEqual(["first","second"]);
    await expect(lstat(options.directory)).rejects.toMatchObject({code:"ENOENT"});
  });

  it("empty recovery preview does not create a profile, journal or lock", async () => {
    const { options } = await fixture();
    expect(await recoverFileTransactions({...options,dryRun:true})).toEqual({pending:false,outcome:"none",targets:0});
    await expect(lstat(options.directory)).rejects.toMatchObject({code:"ENOENT"});
  });

  it.each(["version", "duplicate", "outside", "artifact", "parents", "intent-index", "truncated-plan", "malformed", "bad-utf8", "unknown-field", "early-commit"])("refuses %s journal data before recovery mutations", async (kind) => {
    const { root, files, options } = await fixture();
    expect(await child(applyScript(files, options, "install", 0), root)).toEqual({code:null,signal:"SIGKILL"});
    const path = join(options.directory,"active.jsonl");
    const records = (await readFile(path,"utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    if (kind === "version") records[0].version = 100;
    if (kind === "duplicate") records[0].targets.push(records[0].targets[0]);
    if (kind === "outside") records[0].targets[0].path = join(root,"outside");
    if (kind === "artifact") records[1].artifact.path = join(root,"foreign");
    if (kind === "parents") records[0].targets[0].parents[0].path = root;
    if (kind === "intent-index") records[1].index = 1;
    if (kind === "unknown-field") records[1].unknown = true;
    if (kind === "early-commit") records.push({kind:"commit"});
    await writeFile(path, kind === "truncated-plan" ? "{" : kind === "malformed" ? "{bad}\n" : kind === "bad-utf8" ? new Uint8Array([255,10]) : `${records.map((record)=>JSON.stringify(record)).join("\n")}\n`, {mode:0o600});
    await expect(recoverFileTransactions(options)).rejects.toThrow("recovery");
    expect(await readFile(join(files,"first"),"utf8")).toBe("incoming");
    expect(await readFile(join(files,"second"),"utf8")).toBe("second original");
  });

  it("ignores only an incomplete final intent append, without losing prior durable work", async () => {
    const { root, files, options } = await fixture();
    await child(applyScript(files,options,"install",0),root);
    await appendFile(join(options.directory,"active.jsonl"),"{\"kind\":\"intent\"");
    await recoverFileTransactions(options);
    expect(await readFile(join(files,"first"),"utf8")).toBe("first original");
  });

  it.each(["symlink", "hardlink", "directory", "public", "oversize"])("refuses an unsafe %s journal without following or deleting it", async (kind) => {
    const { root, files, options } = await fixture();
    await mkdir(options.directory,{recursive:true,mode:0o700});
    const path = join(options.directory,"active.jsonl"), foreign = join(root,"foreign");
    await writeFile(foreign,"foreign original",{mode:0o600});
    if(kind==="symlink") await symlink(foreign,path);
    if(kind==="hardlink") await link(foreign,path);
    if(kind==="directory") await mkdir(path);
    if(kind==="public") {await writeFile(path,"{}\n",{mode:0o600});await chmod(path,0o644);}
    if(kind==="oversize") { const handle=await (await import("node:fs/promises")).open(path,"wx",0o600); await handle.truncate(32*1024*1024+1);await handle.close(); }
    await expect(recoverFileTransactions(options)).rejects.toThrow("recovery");
    expect(await readFile(foreign,"utf8")).toBe("foreign original");
    expect(await readFile(join(files,"first"),"utf8")).toBe("first original");
  });

  it.each(["parent", "artifact", "unknown-child", "prepared", "backup", "missing-backup"])("retains evidence after post-crash %s interference", async (kind) => {
    const { root, files, options } = await fixture();
    await child(applyScript(files,options,"install",0),root);
    const artifact = join(files,(await readdir(files)).find(name=>name.startsWith("first.statecase-"))!);
    const secondArtifact = join(files,(await readdir(files)).find(name=>name.startsWith("second.statecase-"))!);
    if(kind==="parent") {await rename(files,join(root,"moved"));await mkdir(files);await writeFile(join(files,"first"),"foreign");}
    if(kind==="artifact") {await rename(artifact,join(root,"moved"));await mkdir(artifact);await writeFile(join(artifact,"backup"),"foreign");}
    if(kind==="unknown-child") await writeFile(join(artifact,"unknown"),"foreign");
    if(kind==="prepared") await writeFile(join(secondArtifact,"prepared"),"foreign");
    if(kind==="backup") await writeFile(join(artifact,"backup"),"foreign");
    if(kind==="missing-backup") await rm(join(artifact,"backup"));
    await expect(recoverFileTransactions(options)).rejects.toThrow("recovery");
    expect(await readFile(join(files,"first"),"utf8")).toBe(kind==="parent"?"foreign":"incoming");
    expect((await lstat(join(options.directory,"active.jsonl"))).isFile()).toBe(true);
  });
});
