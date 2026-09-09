import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cryptography from "@statecase/crypto";
import * as filesystem from "node:fs/promises";
import { computeObjectId, randomKey } from "@statecase/crypto";
import { captureFileGuard } from "../src/file-guard.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "statecase-file-guard-")); roots.push(root); return root; }

describe("streamed local precommit observations (SY-012)", () => {
  it.each(["grow", "truncate"])("refuses %s between metadata capture and streamed reads", async (mode) => {
    const root = await fixture(), path = join(root, "file"), key = await randomKey(); await writeFile(path, "original");
    const realHash = cryptography.computeObjectIdStream;
    vi.spyOn(cryptography, "computeObjectIdStream").mockImplementationOnce(async (key, chunks) => {
      await writeFile(path, mode === "grow" ? "original and more" : "short");
      return realHash(key, chunks);
    });
    await expect(captureFileGuard(root, path, key)).rejects.toThrow("local file changed or cannot be observed safely");
  });
  it("rejects a parent substitution during an absent-file observation and redacts open failures", async () => {
    const root = await fixture(), folder = join(root, "nested"), path = join(folder, "file"), key = await randomKey();
    await mkdir(folder);
    const realOpen = filesystem.open;
    vi.spyOn(filesystem, "open").mockImplementationOnce(async (path, flags, mode) => {
      await rename(folder, join(root, "old")); await mkdir(folder);
      return realOpen(path, flags, mode);
    });
    await expect(captureFileGuard(root, path, key)).rejects.toThrow();
    vi.spyOn(filesystem, "open").mockRejectedValueOnce(Object.assign(new Error("private-path-canary"), { code: "EACCES" }));
    await expect(captureFileGuard(root, path, key)).rejects.toThrow("local file changed or cannot be observed safely");
  });
  it("hashes bounded chunks, observes exact bytes and detects later edits", async () => {
    const root = await fixture(), path = join(root, "file"), key = await randomKey();
    const bytes = Buffer.alloc(150_123, 7); await writeFile(path, bytes);
    const chunksSeen: Uint8Array[] = [], realHash = cryptography.computeObjectIdStream;
    vi.spyOn(cryptography, "computeObjectIdStream").mockImplementationOnce((key, chunks) => realHash(key, (async function* () {
      for await (const chunk of chunks) { chunksSeen.push(chunk); yield chunk; }
    })()));
    const guard = await captureFileGuard(root, path, key);
    expect(chunksSeen).toHaveLength(3); expect(chunksSeen.every((chunk) => chunk.length <= 64 * 1024 && chunk.every((byte) => byte === 0))).toBe(true);
    expect(guard.digest).toBe(await computeObjectId(key, bytes)); await guard.assertUnchanged();
    await writeFile(path, Buffer.alloc(bytes.length, 9));
    await expect(guard.assertUnchanged()).rejects.toThrow("local file changed or cannot be observed safely");
  });
  it("does not create missing parents, permits safe staging directories and detects file creation", async () => {
    const parent = await fixture(), root = join(parent, "missing"), path = join(root, "nested", "file");
    const guard = await captureFileGuard(root, path, await randomKey());
    expect(guard.digest).toBeUndefined(); await guard.assertUnchanged();
    await expect(readFile(root)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(root, "nested"), { recursive: true }); await guard.assertUnchanged();
    await writeFile(path, "local"); await expect(guard.assertUnchanged()).rejects.toThrow();
  });
  it.each(["link", "directory", "parent-link"])("rejects unsafe %s without native diagnostics", async (mode) => {
    const root = await fixture(), path = join(root, "nested", "file"), other = join(root, "canary");
    await mkdir(join(root, "nested")); await writeFile(other, "secret");
    if (mode === "link") await symlink(other, path);
    if (mode === "directory") await mkdir(path);
    if (mode === "parent-link") { await rm(join(root, "nested"), { recursive: true }); await symlink(root, join(root, "nested")); }
    await expect(captureFileGuard(root, path, await randomKey())).rejects.toThrow("local file changed or cannot be observed safely");
  });
  it.each(["mode", "parent-mode", "hardlink"])("preserves the ordinary-file permission policy but detects later %s changes", async (mode) => {
    const root = await fixture(), path = join(root, "file"); await writeFile(path, "shared file", { mode: 0o664 });
    const guard = await captureFileGuard(root, path, await randomKey()); await guard.assertUnchanged();
    if (mode === "mode") await chmod(path, 0o666);
    if (mode === "parent-mode") await chmod(root, 0o777);
    if (mode === "hardlink") await link(path, join(root, "second-name"));
    await expect(guard.assertUnchanged()).rejects.toThrow();
  });
  it("detects replaced parents even when the file itself was moved without changing bytes", async () => {
    const root = await fixture(), path = join(root, "nested", "file");
    await mkdir(join(root, "nested")); await writeFile(path, "bytes");
    const guard = await captureFileGuard(root, path, await randomKey());
    await rename(join(root, "nested"), join(root, "old")); await mkdir(join(root, "nested"));
    await rename(join(root, "old", "file"), path);
    await expect(guard.assertUnchanged()).rejects.toThrow();
  });
  it("bounds reads and rejects changes during observation, unsafe paths and invalid limits", async () => {
    const root = await fixture(), path = join(root, "file"), key = await randomKey(); await writeFile(path, "original");
    await expect(captureFileGuard(root, path, key, { maximumBytes: 4 })).rejects.toThrow();
    for (const maximumBytes of [0, -1, Infinity]) await expect(captureFileGuard(root, path, key, { maximumBytes })).rejects.toThrow();
    for (const target of [root, join(root, "..", "outside"), path + "\u0000bad"]) await expect(captureFileGuard(root, target, key)).rejects.toThrow();
    await expect(captureFileGuard(root, path, key, { afterRead: () => writeFile(path, "replaced") })).rejects.toThrow();
    await expect(captureFileGuard(root, path, key, { afterRead: () => rm(path) })).rejects.toThrow();
  });
});
