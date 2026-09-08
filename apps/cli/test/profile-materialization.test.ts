import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.js";
import { runCli, type CliIO } from "../src/bin.js";

const temporary: string[]=[];
let bundleRoot:string,bundle:string;
beforeAll(async()=>{
  bundleRoot=await mkdtemp(join(tmpdir(),"statecase-profile-replay-bundle-"));bundle=join(bundleRoot,"config.mjs");
  await build({entryPoints:[fileURLToPath(new URL("../src/config.ts",import.meta.url))],outfile:bundle,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent",
    plugins:[{name:"isolated-native-module",setup(builder){builder.onResolve({filter:/^better-sqlite3$/},()=>({path:createRequire(import.meta.url).resolve("better-sqlite3"),external:true}));}}]});
});
afterAll(async()=>{if(bundleRoot)await rm(bundleRoot,{recursive:true,force:true});});
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(temporary.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"statecase-profile-replay-"));temporary.push(root);
  const home=join(root,"profile"),files=join(root,"files");await mkdir(files);
  await writeFile(join(files,"note"),"original note");await writeFile(join(files,"obsolete"),"original obsolete");
  const store=new ConfigStore(home),config=await store.loadConfig();
  config.mappings=[{id:"notes",kind:"drop",mode:"two-way",name:"notes",namespace:"drop:notes",path:files}];
  config.applied={"drop:notes":{revisionId:"old-revision",digests:{note:"old-digest"}}};
  await store.saveConfig(config);
  return {root,home,files,store,original:await readFile(join(home,"config.json"),"utf8")};
}
async function child(script:string,root:string){
  const proc=spawn(process.execPath,["--input-type=module","-e",`import {ConfigStore} from ${JSON.stringify(pathToFileURL(bundle).href)}; ${script}`],{cwd:root,stdio:"ignore",
    env:{HOME:root,STATECASE_HOME:join(root,"profile"),CODEX_HOME:join(root,"codex"),CLAUDE_CONFIG_DIR:join(root,"claude")} as unknown as NodeJS.ProcessEnv});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;proc.kill("SIGKILL");},10000);
  const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{proc.once("error",reject);proc.once("exit",(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timer));
  expect(timedOut).toBe(false);return result;
}
function applyScript(home:string,files:string,phase:string,index:number){
  return `const store=new ConfigStore(${JSON.stringify(home)}),config=await store.loadConfig();
    config.applied["drop:notes"]={revisionId:"new-revision",digests:{note:"new-digest"}};config.sessionBindings={session:"portable-binding"};
    await store.materializeConfig(config,{writes:[{path:${JSON.stringify(join(files,"note"))},bytes:new TextEncoder().encode("incoming note")}],deletes:[${JSON.stringify(join(files,"obsolete"))}]},
      {afterBoundary:(phase,index)=>{if(phase===${JSON.stringify(phase)}&&index===${index})process.kill(process.pid,"SIGKILL");}});`;
}
describe("one durable native/profile checkpoint (RT-006, BK-009)",()=>{
  it.each([["install",0],["backup",2],["install",2]] as const)("restores native files and exact profile after kill at %s/%s",async(phase,index)=>{
    const {root,home,files,store,original}=await fixture();
    expect(await child(applyScript(home,files,phase,index),root)).toEqual({code:null,signal:"SIGKILL"});
    await expect(store.loadConfig()).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
    expect(await store.recoverMaterialization({dryRun:true})).toMatchObject({pending:true,outcome:"rollback"});
    expect(await child(`await new ConfigStore(${JSON.stringify(home)}).recoverMaterialization();`,root)).toEqual({code:0,signal:null});
    expect(await readFile(join(home,"config.json"),"utf8")).toBe(original);
    expect(await readFile(join(files,"note"),"utf8")).toBe("original note");
    expect(await readFile(join(files,"obsolete"),"utf8")).toBe("original obsolete");
    expect((await store.loadConfig()).applied["drop:notes"].revisionId).toBe("old-revision");
    expect(await store.recoverMaterialization()).toMatchObject({pending:false});
  });
  it.each(["commit","files-finished"])("preserves the matched committed profile and files after %s interruption",async phase=>{
    const {root,home,files,store}=await fixture();
    expect(await child(applyScript(home,files,phase,-1),root)).toEqual({code:null,signal:"SIGKILL"});
    await store.recoverMaterialization();
    const config=await store.loadConfig();
    expect(config.applied["drop:notes"].revisionId).toBe("new-revision");
    expect(config.sessionBindings).toEqual({session:"portable-binding"});
    expect(await readFile(join(files,"note"),"utf8")).toBe("incoming note");
    expect(await readdir(files)).toEqual(["note"]);
  });
  it("normal completion updates the observed config object for subsequent guarded saves",async()=>{
    const {files,store}=await fixture(),config=await store.loadConfig();
    config.applied["drop:notes"]={revisionId:"new-revision",digests:{}};
    await store.materializeConfig(config,{writes:[{path:join(files,"note"),bytes:new TextEncoder().encode("incoming note")}],deletes:[]});
    config.deviceName="after-checkpoint";await store.saveConfig(config);
    expect((await store.loadConfig()).deviceName).toBe("after-checkpoint");
  });

  it("a failed apply invalidates its in-memory proposal instead of allowing a later marker-only save",async()=>{
    const {files,store,original,home}=await fixture(),config=await store.loadConfig();
    config.applied["drop:notes"]={revisionId:"must-not-advance",digests:{}};
    await expect(store.materializeConfig(config,{writes:[{path:join(files,"note"),bytes:new Uint8Array([1])}],deletes:[],beforeCommit:()=>{throw new Error("injected refusal");}})).rejects.toThrow("injected refusal");
    await expect(store.saveConfig(config)).rejects.toMatchObject({code:"CONFIG_STATE_CHANGED"});
    expect(await readFile(join(home,"config.json"),"utf8")).toBe(original);
  });

  it.each(["load","save","status","upgrade"])("blocks %s while a crashed checkpoint is pending",async operation=>{
    const {root,home,files,store}=await fixture(),stale=await store.loadConfig();
    await child(applyScript(home,files,"install",0),root);
    const action=operation==="load"?()=>store.loadConfig():operation==="save"?()=>store.saveConfig(stale):operation==="status"?()=>store.profileStatus():()=>store.upgradeProfile({dryRun:true});
    await expect(action()).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
  });

  it("restart recovery remains idempotent if interrupted after restoring the profile",async()=>{
    const {root,home,files,store,original}=await fixture();
    await child(applyScript(home,files,"install",2),root);
    expect(await child(`await new ConfigStore(${JSON.stringify(home)}).recoverMaterialization({afterBoundary:(phase,index)=>{if(phase==="rollback"&&index===2)process.kill(process.pid,"SIGKILL");}});`,root)).toEqual({code:null,signal:"SIGKILL"});
    expect(await readFile(join(home,"config.json"),"utf8")).toBe(original);
    await expect(store.loadConfig()).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
    await store.recoverMaterialization();
    expect(await readFile(join(files,"note"),"utf8")).toBe("original note");
  });

  it.each(["checkpoint-published","file-plan-published","checkpoint-applying","checkpoint-settled"])("handles process death at %s without losing the outer decision",async phase=>{
    const {root,home,files,store,original}=await fixture();
    expect(await child(applyScript(home,files,phase,-1),root)).toEqual({code:null,signal:"SIGKILL"});
    await store.recoverMaterialization();
    if(phase==="checkpoint-settled")expect((await store.loadConfig()).applied["drop:notes"].revisionId).toBe("new-revision");
    else expect(await readFile(join(home,"config.json"),"utf8")).toBe(original);
  });

  it("does not interpret a deleted journal as a successful transaction",async()=>{
    const {root,home,files,store}=await fixture();
    await child(applyScript(home,files,"install",0),root);
    await rm(join(home,"materialization","active.jsonl"));
    await expect(store.recoverMaterialization()).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
    expect(await readFile(join(files,"note"),"utf8")).toBe("incoming note");
    await expect(store.loadConfig()).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
  });

  it("leaves profile and files byte-exact during recovery preview",async()=>{
    const {root,home,files,store}=await fixture();
    await child(applyScript(home,files,"install",2),root);
    const checkpoint=await readFile(join(home,"profile-materialization.json")),profile=await readFile(join(home,"config.json"));
    const journal=await readFile(join(home,"materialization","active.jsonl"));
    expect(await store.recoverMaterialization({dryRun:true})).toMatchObject({pending:true});
    expect(await readFile(join(home,"profile-materialization.json"))).toEqual(checkpoint);
    expect(await readFile(join(home,"config.json"))).toEqual(profile);
    expect(await readFile(join(home,"materialization","active.jsonl"))).toEqual(journal);
  });

  it("refuses independent profile edits after a committed transaction",async()=>{
    const {root,home,files,store}=await fixture();
    await child(applyScript(home,files,"files-finished",-1),root);
    const path=join(home,"config.json"),bytes=await readFile(path,"utf8");
    await writeFile(path,bytes.replace("new-revision","independent-revision"),{mode:0o600});
    await expect(store.recoverMaterialization()).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
    expect(await readFile(path,"utf8")).toContain("independent-revision");
  });

  it.each(["mapping","api","device","unknown"])("refuses %s changes mixed into applied-state publication",async kind=>{
    const {files,store,home,original}=await fixture(),config=await store.loadConfig();
    if(kind==="mapping")config.mappings[0].path=home;
    if(kind==="api")config.apiUrl="https://changed.invalid";
    if(kind==="device")config.deviceName="different-device";
    if(kind==="unknown")Object.assign(config,{unknownField:true});
    await expect(store.materializeConfig(config,{writes:[{path:join(files,"note"),bytes:new Uint8Array([1])}],deletes:[]})).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
    expect(await readFile(join(home,"config.json"),"utf8")).toBe(original);
    expect(await readFile(join(files,"note"),"utf8")).toBe("original note");
  });

  it("does not grant writes under an identity-only workspace or to metadata siblings",async()=>{
    const {root,files,store,home}=await fixture(),initial=await store.loadConfig();
    initial.workspaces=[{id:"identity",path:root,sync:"identity-only"}];await store.saveConfig(initial);
    for(const path of [join(root,"outside"),join(home,"credentials.json")]){
      const config=await store.loadConfig();
      await expect(store.materializeConfig(config,{writes:[{path,bytes:new Uint8Array([1])}],deletes:[]})).rejects.toThrow();
      await expect(lstat(path)).rejects.toMatchObject({code:"ENOENT"});
    }
    const config=await store.loadConfig();
    await store.materializeConfig(config,{writes:[{path:join(files,"note"),bytes:new Uint8Array([1])}],deletes:[]});
  });

  it.each(["invalid","hash","version","phase","receipt","permissions","symlink"])("refuses an unsafe %s checkpoint without changing native state",async kind=>{
    const {root,home,files,store}=await fixture();
    await child(applyScript(home,files,"install",0),root);
    const path=join(home,"profile-materialization.json"),text=await readFile(path,"utf8"),checkpoint=JSON.parse(text);
    if(kind==="hash")checkpoint.beforeHash="0".repeat(64);
    if(kind==="version")checkpoint.version=999;
    if(kind==="phase")checkpoint.phase="settled";
    if(kind==="receipt")checkpoint.settled={outcome:"rollback",profileHash:checkpoint.beforeHash};
    if(kind==="permissions")await chmod(path,0o644);
    else if(kind==="symlink"){await writeFile(join(root,"foreign"),text,{mode:0o600});await rm(path);await symlink(join(root,"foreign"),path);}
    else await writeFile(path,kind==="invalid"?"broken":JSON.stringify(checkpoint),{mode:0o600});
    await expect(store.recoverMaterialization()).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
    expect(await readFile(join(files,"note"),"utf8")).toBe("incoming note");
  });
  it("no-pending preview leaves an unconfigured profile absent",async()=>{
    const root=await mkdtemp(join(tmpdir(),"statecase-profile-recovery-empty-"));temporary.push(root);
    const home=join(root,"missing");expect(await new ConfigStore(home).recoverMaterialization({dryRun:true})).toMatchObject({pending:false});
    await expect(lstat(home)).rejects.toMatchObject({code:"ENOENT"});
  });

  it("refuses an orphan active journal when the outer checkpoint has disappeared",async()=>{
    const {root,home,files,store}=await fixture();await child(applyScript(home,files,"install",0),root);
    await rm(join(home,"profile-materialization.json"));
    await expect(store.loadConfig()).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
    await expect(store.recoverMaterialization()).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
    expect(await readFile(join(files,"note"),"utf8")).toBe("incoming note");
  });

  it("rejects a settled witness that disagrees with the journal decision before replay",async()=>{
    const {root,home,files,store}=await fixture();await child(applyScript(home,files,"commit",-1),root);
    const path=join(home,"profile-materialization.json"),checkpoint=JSON.parse(await readFile(path,"utf8"));
    checkpoint.phase="settled";checkpoint.settled={outcome:"rollback",profileHash:checkpoint.beforeHash};
    await writeFile(path,JSON.stringify(checkpoint),{mode:0o600});
    await expect(store.recoverMaterialization()).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
    expect(await readFile(join(home,"config.json"),"utf8")).toContain("new-revision");
    expect(await readFile(join(files,"note"),"utf8")).toBe("incoming note");
  });

  it("invalidates old observations in the recovering ConfigStore",async()=>{
    const {root,home,files,store}=await fixture(),stale=await store.loadConfig();
    await child(applyScript(home,files,"install",0),root);await store.recoverMaterialization();
    stale.applied["drop:notes"]={revisionId:"stale-proposal",digests:{}};
    await expect(store.saveConfig(stale)).rejects.toMatchObject({code:"CONFIG_STATE_CHANGED"});
  });

  it("refuses stale proposals before creating an outer checkpoint",async()=>{
    const {home,files,store}=await fixture(),stale=await store.loadConfig(),fresh=await store.loadConfig();
    fresh.deviceName="changed";await store.saveConfig(fresh);
    await expect(store.materializeConfig(stale,{writes:[{path:join(files,"note"),bytes:new Uint8Array([1])}],deletes:[]})).rejects.toMatchObject({code:"CONFIG_STATE_CHANGED"});
    await expect(lstat(join(home,"profile-materialization.json"))).rejects.toMatchObject({code:"ENOENT"});
  });

  it("supports a metadata-only checkpoint without granting its directory",async()=>{
    const {store}=await fixture(),initial=await store.loadConfig();initial.mappings=[];await store.saveConfig(initial);
    const config=await store.loadConfig();config.sessionBindings={session:"binding"};
    await store.materializeConfig(config,{writes:[],deletes:[]});
    expect((await store.loadConfig()).sessionBindings).toEqual({session:"binding"});
  });

  it("holds the config mutex across native mutation and final profile publication",async()=>{
    const {files,store,home}=await fixture(),config=await store.loadConfig(),peer=new ConfigStore(home),stale=await peer.loadConfig();
    let blocked=false;
    await store.materializeConfig(config,{writes:[{path:join(files,"note"),bytes:new Uint8Array([1])}],deletes:[]},{
      afterBoundary:async phase=>{if(phase==="install"){
        await expect(peer.saveConfig(stale)).rejects.toMatchObject({code:"CONFIG_STATE_CHANGED"});
        await expect(peer.recoverMaterialization()).rejects.toMatchObject({code:"CONFIG_STATE_CHANGED"});blocked=true;
      }},
    });
    expect(blocked).toBe(true);
  });

  it("can stop its installed daemon using the pre-checkpoint profile while config.json is absent",async()=>{
    const {root,home,files,store}=await fixture();
    vi.stubEnv("HOME",root);vi.stubEnv("STATECASE_HOME",home);vi.stubEnv("CODEX_HOME",join(root,"codex"));vi.stubEnv("CLAUDE_CONFIG_DIR",join(root,"claude"));
    vi.stubEnv("STATECASE_KEYCHAIN_PATH",join(root,"synthetic.keychain-db"));
    const output:string[]=[],errors:string[]=[],calls:string[][]=[];let definitionPath="";
    const io:CliIO={stdout:value=>output.push(value),stderr:value=>errors.push(value),fetch:async()=>{throw new Error("network forbidden in service fixture");},
      serviceRunner:async(_file,args)=>{calls.push([...args]);return{stdout:args.includes("show")?`${definitionPath}\n`:args[0]==="print"?`\tpath = ${definitionPath}\n`:""};}};
    expect(await runCli(["node","statecase","--json","daemon","install","--no-start"],io)).toBe(0);
    definitionPath=JSON.parse(output.at(-1)!).path;
    await child(applyScript(home,files,"backup",2),root);
    await expect(lstat(join(home,"config.json"))).rejects.toMatchObject({code:"ENOENT"});
    expect(await runCli(["node","statecase","--json","daemon","start"],io)).toBe(6);
    expect(await runCli(["node","statecase","--json","daemon","stop"],io)).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    await expect(store.loadConfig()).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
    await store.recoverMaterialization();
  });

  it.each(["dry-run","final-writes"])("refuses unsupported %s apply composition before a checkpoint",async kind=>{
    const {files,home,store}=await fixture(),config=await store.loadConfig();
    await expect(store.materializeConfig(config,{writes:[],deletes:[],...(kind==="final-writes"?{finalWrites:[{path:join(files,"note"),bytes:new Uint8Array([1])}]}:{})},{dryRun:kind==="dry-run"})).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
    await expect(lstat(join(home,"profile-materialization.json"))).rejects.toMatchObject({code:"ENOENT"});
  });

  it("refuses a checkpoint substituted before phase publication without replacing it",async()=>{
    const {home,files,store}=await fixture(),config=await store.loadConfig();
    let foreign="";
    await expect(store.materializeConfig(config,{writes:[{path:join(files,"note"),bytes:new Uint8Array([1])}],deletes:[]},{afterBoundary:async phase=>{
      if(phase==="checkpoint-published"){
        const path=join(home,"profile-materialization.json"),data=JSON.parse(await readFile(path,"utf8"));data.id=crypto.randomUUID();foreign=JSON.stringify(data);await writeFile(path,foreign,{mode:0o600});
      }
    }})).rejects.toMatchObject({code:"PROFILE_RECOVERY_REQUIRED"});
    expect(await readFile(join(home,"profile-materialization.json"),"utf8")).toBe(foreign);
    expect(await readFile(join(files,"note"),"utf8")).toBe("original note");
  });
});
