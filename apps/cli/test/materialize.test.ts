import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";

import { applyFileTransaction, targetFingerprint } from "../src/materialize.js";

const temporary: string[] = [];

async function recoveryBackups(root: string): Promise<string[]> {
  const artifacts = (await readdir(root)).filter((name) => name.includes(".statecase-transaction-"));
  const backups: string[] = [];
  for (const artifact of artifacts) {
    const path = join(root, artifact, "backup");
    try { await lstat(path); backups.push(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return backups;
}

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("transactional native materialization (BK-008, BK-009, WS-025)", () => {
  it.each(["modified", "replaced", "symlink"])("rejects a %s descriptor observation with fixed diagnostics",async kind=>{
    const root=await mkdtemp(join(tmpdir(),"statecase-materializer-observation-"));temporary.push(root);
    const path=join(root,"file");await writeFile(path,"original");
    await expect(targetFingerprint(path,{afterRead:async()=>{
      if(kind!=="modified")await rm(path);
      if(kind==="symlink")await symlink("other",path);else await writeFile(path,"modified");
    }})).rejects.toThrow(/^unsafe materialization observation$/u);
  });

  it("bounds observed file size and validates the observation budget",async()=>{
    const root=await mkdtemp(join(tmpdir(),"statecase-materializer-bounds-"));temporary.push(root);
    const path=join(root,"file");await writeFile(path,"original");
    for(const maximumBytes of [0,-1,NaN,1.5,4])await expect(targetFingerprint(path,{maximumBytes})).rejects.toThrow("unsafe materialization observation");
    expect(await targetFingerprint(path,{maximumBytes:8})).toContain("[");
  });
  it.each(["file", "directory", "symlink"])("preserves a pre-existing %s at the staging reservation (RT-006)", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "statecase-reservation-"));
    temporary.push(root);
    const path = join(root, "destination");
    const nonce = "11111111-2222-4333-8444-555555555555";
    const artifact = `${path}.statecase-transaction-${nonce}.staged`;
    vi.spyOn(crypto, "randomUUID").mockReturnValue(nonce);
    await writeFile(path, "original");
    if (kind === "file") await writeFile(artifact, "foreign recovery bytes");
    if (kind === "directory") { await mkdir(artifact); await writeFile(join(artifact, "foreign"), "foreign recovery bytes"); }
    if (kind === "symlink") { await writeFile(join(root, "referent"), "foreign recovery bytes"); await symlink("referent", artifact); }
    await expect(applyFileTransaction({ writes: [{ path, bytes: new TextEncoder().encode("remote") }], deletes: [] })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("original");
    if (kind === "directory") expect(await readFile(join(artifact, "foreign"), "utf8")).toBe("foreign recovery bytes");
    else expect(await readFile(artifact, "utf8")).toBe("foreign recovery bytes");
    if (kind === "symlink") expect(await readlink(artifact)).toBe("referent");
  });

  it("never overwrites or removes a legacy backup collision (RT-006)", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-backup-reservation-"));
    temporary.push(root);
    const path = join(root, "destination"), nonce = "11111111-2222-4333-8444-555555555555";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(nonce);
    const backup = `${path}.statecase-transaction-${nonce}.backup`;
    await writeFile(path, "original");
    await writeFile(backup, "foreign recovery bytes");
    await applyFileTransaction({ writes: [{ path, bytes: new TextEncoder().encode("remote") }], deletes: [] });
    expect(await readFile(path, "utf8")).toBe("remote");
    expect(await readFile(backup, "utf8")).toBe("foreign recovery bytes");
  });

  it("cleans only its own earlier reservation if a later target collides", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-late-reservation-"));
    temporary.push(root);
    const nonce = "11111111-2222-4333-8444-555555555555";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(nonce);
    const first = join(root, "first"), second = join(root, "second");
    await writeFile(first, "first original"); await writeFile(second, "second original");
    const artifact = `${second}.statecase-transaction-${nonce}.staged`;
    await writeFile(artifact, "foreign recovery bytes");
    await expect(applyFileTransaction({ writes: [first, second].map((path) => ({ path, bytes: new Uint8Array([1]) })), deletes: [] })).rejects.toThrow();
    expect(await readFile(first, "utf8")).toBe("first original");
    expect(await readFile(second, "utf8")).toBe("second original");
    expect(await readFile(artifact, "utf8")).toBe("foreign recovery bytes");
    expect((await readdir(root)).filter((name) => name.includes(".statecase-transaction-"))).toEqual([artifact.slice(root.length + 1)]);
  });

  it.each(["directory", "symlink", "file", "absent"])("preserves a substituted %s artifact and refuses cleanup", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "statecase-artifact-substitution-"));
    temporary.push(root);
    const path = join(root, "destination"), moved = join(root, "moved-owned-artifact");
    await writeFile(path, "original");
    let artifact = "";
    await expect(applyFileTransaction({
      writes: [{ path, bytes: new TextEncoder().encode("remote") }], deletes: [],
      beforeCommit: async () => {
        artifact = join(root, (await readdir(root)).find((name) => name.includes(".statecase-transaction-"))!);
        expect((await lstat(artifact)).mode & 0o777).toBe(0o700);
        await rename(artifact, moved);
        if (kind === "directory") { await mkdir(artifact); await writeFile(join(artifact, "prepared"), "foreign"); }
        if (kind === "symlink") { await mkdir(join(root, "referent")); await writeFile(join(root, "referent", "prepared"), "foreign"); await symlink("referent", artifact); }
        if (kind === "file") await writeFile(artifact, "foreign");
      },
    })).rejects.toThrow("transaction artifact changed; recovery files retained");
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readFile(join(moved, "prepared"), "utf8")).toBe("remote");
    if (kind === "directory" || kind === "symlink") expect(await readFile(join(artifact, "prepared"), "utf8")).toBe("foreign");
    if (kind === "file") expect(await readFile(artifact, "utf8")).toBe("foreign");
    if (kind === "absent") await expect(lstat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains unexpected children and original recovery bytes without recursive cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-artifact-unknown-"));
    temporary.push(root);
    const path = join(root, "destination");
    await writeFile(path, "original");
    let artifact = "";
    await expect(applyFileTransaction({ writes: [{ path, bytes: new TextEncoder().encode("remote") }], deletes: [],
      beforeCommit: async () => {
        artifact = join(root, (await readdir(root)).find((name) => name.includes(".statecase-transaction-"))!);
        await writeFile(join(artifact, "unknown"), "foreign recovery bytes");
      },
    })).rejects.toThrow("unexpected transaction artifact; recovery files retained");
    expect(await readFile(join(artifact, "unknown"), "utf8")).toBe("foreign recovery bytes");
    expect(await readFile(join(artifact, "backup"), "utf8")).toBe("original");
    expect(await readFile(path, "utf8")).toBe("remote");
  });

  it("retains private exact originals after actual SIGKILL between installs (RT-006 prerequisite, not replay qualification)", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-materialization-kill-"));
    temporary.push(root);
    const bundle = join(root, "materialize.mjs"), first = join(root, "first"), second = join(root, "second");
    await writeFile(first, "first original"); await writeFile(second, "second original");
    await build({ entryPoints: [fileURLToPath(new URL("../src/materialize.ts", import.meta.url))], outfile: bundle,
      bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
    const script = `import { applyFileTransaction } from ${JSON.stringify(pathToFileURL(bundle).href)};
      await applyFileTransaction({ writes: ${JSON.stringify([first, second])}.map(path => ({path, bytes: new TextEncoder().encode("remote")})),
        deletes: [], beforeCommit: index => { if (index === 1) process.kill(process.pid, "SIGKILL"); } });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      // Worker bindings globally augment ProcessEnv; this isolated filesystem
      // child deliberately receives neither those bindings nor operator secrets.
      cwd: root, env: { HOME: root, STATECASE_HOME: join(root, "profile"), CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude") } as unknown as NodeJS.ProcessEnv,
      stdio: "ignore",
    });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10_000);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timeout));
    expect(result).toEqual({ code: null, signal: "SIGKILL" });
    expect(timedOut).toBe(false);
    expect(await readFile(first, "utf8")).toBe("remote");
    expect(await readFile(second, "utf8")).toBe("second original");
    const backups = await recoveryBackups(root);
    expect(backups).toHaveLength(1);
    expect(await readFile(backups[0], "utf8")).toBe("first original");
    expect((await lstat(join(backups[0], ".."))).mode & 0o777).toBe(0o700);
  }, 15_000);

  it("atomically creates, replaces, and deletes a set of files", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-apply-"));
    temporary.push(root);
    await writeFile(join(root, "replace.txt"), "old");
    await writeFile(join(root, "delete.txt"), "obsolete");

    await applyFileTransaction({
      writes: [
        { path: join(root, "replace.txt"), bytes: new TextEncoder().encode("new") },
        { path: join(root, "nested", "create.txt"), bytes: new TextEncoder().encode("created"), mode: 0o700 },
      ],
      deletes: [join(root, "delete.txt")],
      symlinks: [{ path: join(root, "portable-link"), target: "replace.txt" }],
    });

    expect(await readFile(join(root, "replace.txt"), "utf8")).toBe("new");
    expect(await readFile(join(root, "nested", "create.txt"), "utf8")).toBe("created");
    if (process.platform !== "win32") expect((await (await import("node:fs/promises")).lstat(join(root, "nested", "create.txt"))).mode & 0o777).toBe(0o700);
    await expect(readFile(join(root, "delete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(join(root, "portable-link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, "portable-link"))).toBe("replace.txt");
    expect((await readdir(root)).every((name) => !name.includes(".statecase-transaction-"))).toBe(true);
  });

  it("atomically installs a file-backed write without loading it into the transaction API", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-apply-file-backed-"));
    temporary.push(root);
    const sourcePath = join(root, "verified-download.staged");
    const destination = join(root, "restored", "session.jsonl");
    await writeFile(sourcePath, "large streamed payload\n");

    await applyFileTransaction({ writes: [{ path: destination, sourcePath }], deletes: [] });

    expect(await readFile(destination, "utf8")).toBe("large streamed payload\n");
    expect(await readFile(sourcePath, "utf8")).toBe("large streamed payload\n");
  });

  it("rejects missing and non-regular file-backed sources without changing the destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-apply-source-guard-"));
    temporary.push(root);
    const destination = join(root, "destination.txt");
    await writeFile(destination, "preserved");
    await mkdir(join(root, "directory-source"));

    await expect(applyFileTransaction({ writes: [{ path: destination, sourcePath: join(root, "missing") }], deletes: [] }))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(applyFileTransaction({ writes: [{ path: destination, sourcePath: join(root, "directory-source") }], deletes: [] }))
      .rejects.toThrow("not a regular file");
    expect(await readFile(destination, "utf8")).toBe("preserved");
  });

  it("rolls back every prior replacement and deletion after a mid-commit failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-rollback-"));
    temporary.push(root);
    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    const deleted = join(root, "deleted.txt");
    await Promise.all([writeFile(first, "first-old"), writeFile(second, "second-old"), writeFile(deleted, "keep-me")]);

    await expect(applyFileTransaction({
      writes: [
        { path: first, bytes: new TextEncoder().encode("first-new") },
        { path: second, bytes: new TextEncoder().encode("second-new") },
      ],
      deletes: [deleted],
      symlinks: [],
      beforeCommit: (index) => {
        if (index === 2) throw new Error("injected disk failure");
      },
    })).rejects.toThrow("injected disk failure");

    expect(await readFile(first, "utf8")).toBe("first-old");
    expect(await readFile(second, "utf8")).toBe("second-old");
    expect(await readFile(deleted, "utf8")).toBe("keep-me");
    expect((await readdir(root)).every((name) => !name.includes(".statecase-transaction-"))).toBe(true);
  });

  it("rejects duplicate target paths before changing the filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-duplicate-"));
    temporary.push(root);
    const path = join(root, "same.txt");
    await writeFile(path, "untouched");
    await expect(applyFileTransaction({
      writes: [{ path, bytes: new Uint8Array([1]) }],
      deletes: [path],
      symlinks: [],
    })).rejects.toThrow("duplicate transaction target");
    expect(await readFile(path, "utf8")).toBe("untouched");
  });

  it.each(["replace", "delete", "create"])("preserves an editor's new write and recovery bytes during %s rollback interference (WS-034)", async (operation) => {
    const root = await mkdtemp(join(tmpdir(), "statecase-rollback-interference-"));
    temporary.push(root);
    const first = join(root, "first.txt"), second = join(root, "second.txt");
    if (operation !== "create") await writeFile(first, "original recovery bytes");
    await writeFile(second, "second original");
    const transaction = operation === "delete"
      ? { writes: [], deletes: [first, second] }
      : { writes: [first, second].map((path) => ({ path, bytes: new TextEncoder().encode("remote content") })), deletes: [] };
    await expect(applyFileTransaction({
      ...transaction,
      beforeCommit: async (index) => {
        if (index === 1) {
          await writeFile(first, "editor's newer local work");
          throw new Error("injected failure after editor write");
        }
      },
    })).rejects.toBeInstanceOf(AggregateError);
    expect(await readFile(first, "utf8")).toBe("editor's newer local work");
    expect(await readFile(second, "utf8")).toBe("second original");
    const backups = await recoveryBackups(root);
    if (operation === "create") expect(backups).toEqual([]);
    else {
      expect(backups).toHaveLength(1);
      expect(await readFile(backups[0], "utf8")).toBe("original recovery bytes");
    }
  });

  it.each(["directory", "symlink", "removed"])("retains the original backup when a committed file becomes %s before rollback", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "statecase-rollback-type-race-"));
    temporary.push(root);
    const path = join(root, "first.txt");
    await writeFile(path, "original recovery bytes");
    await expect(applyFileTransaction({
      writes: [{ path, bytes: new TextEncoder().encode("remote version") }],
      deletes: [join(root, "trigger.txt")],
      beforeCommit: async (index) => {
        if (index !== 1) return;
        await rm(path);
        if (kind === "directory") await mkdir(path);
        if (kind === "symlink") await symlink("independent-target", path);
        throw new Error("injected failure after independent type change");
      },
    })).rejects.toBeInstanceOf(AggregateError);
    if (kind === "directory") expect((await lstat(path)).isDirectory()).toBe(true);
    if (kind === "symlink") expect(await readlink(path)).toBe("independent-target");
    if (kind === "removed") await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    const backups = await recoveryBackups(root);
    expect(backups).toHaveLength(1);
    expect(await readFile(backups[0], "utf8")).toBe("original recovery bytes");
  });

  it("rolls back an already-installed symlink without changing either referent", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-installed-link-rollback-"));
    temporary.push(root);
    const path = join(root, "link");
    await writeFile(join(root, "old-target"), "old referent");
    await writeFile(join(root, "new-target"), "new referent");
    await symlink("old-target", path);
    await expect(applyFileTransaction({
      writes: [], symlinks: [{ path, target: "new-target" }], deletes: [join(root, "trigger")],
      beforeCommit: (index) => { if (index === 1) throw new Error("installed link failure"); },
    })).rejects.toThrow("installed link failure");
    expect(await readlink(path)).toBe("old-target");
    expect(await readFile(join(root, "old-target"), "utf8")).toBe("old referent");
    expect(await readFile(join(root, "new-target"), "utf8")).toBe("new referent");
    expect((await readdir(root)).filter((name) => name.includes(".statecase-transaction-"))).toEqual([]);
  });

  it("refuses to replace a directory when optional symlinks are omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-directory-guard-"));
    temporary.push(root);
    const path = join(root, "existing-directory");
    await mkdir(path);

    await expect(applyFileTransaction({
      writes: [{ path, bytes: new TextEncoder().encode("must not replace") }],
      deletes: [],
    })).rejects.toThrow("refusing to replace non-regular file");
    expect((await lstat(path)).isDirectory()).toBe(true);
    expect((await readdir(root)).every((name) => !name.includes(".statecase-transaction-"))).toBe(true);
  });

  it("rolls back a replaced symlink without following its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-symlink-rollback-"));
    temporary.push(root);
    const path = join(root, "link");
    await writeFile(join(root, "outside.txt"), "target remains");
    await symlink("outside.txt", path);
    await expect(applyFileTransaction({
      writes: [],
      symlinks: [{ path, target: "new-target" }],
      deletes: [],
      beforeCommit: () => { throw new Error("injected"); },
    })).rejects.toThrow("injected");
    expect(await readlink(path)).toBe("outside.txt");
    expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("target remains");
  });
});
