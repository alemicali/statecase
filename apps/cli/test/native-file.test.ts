import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNativeFileSnapshot } from "../src/native-file.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "statecase-native-file-")); roots.push(root); return root; }

describe("guarded native text snapshots (AD-CTX-003)", () => {
  it("reads nested owner-controlled bytes, detects changes and wipes on disposal", async () => {
    const root = await fixture(); await mkdir(join(root, "rules"), { mode: 0o700 });
    const path = join(root, "rules", "guide.md"); await writeFile(path, "synthetic\n", { mode: 0o644 });
    const snapshot = await readNativeFileSnapshot(root, "rules/guide.md");
    expect(Buffer.from(snapshot.bytes!).toString()).toBe("synthetic\n"); await snapshot.assertUnchanged();
    await writeFile(path, "changed\n"); await expect(snapshot.assertUnchanged()).rejects.toMatchObject({ code: "NATIVE_FILE_CHANGED" });
    snapshot.dispose(); expect(snapshot.bytes!.every((byte) => byte === 0)).toBe(true);
    await expect(snapshot.assertUnchanged()).rejects.toMatchObject({ code: "NATIVE_FILE_CHANGED" });
  });
  it("observes absent roots/parents without creating them and permits safe staging directories", async () => {
    const parent = await fixture(), root = join(parent, "new");
    const snapshot = await readNativeFileSnapshot(root, "rules/deep/guide.md");
    expect(snapshot.bytes).toBeUndefined(); await expect(readFile(root)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(root, "rules", "deep"), { recursive: true, mode: 0o700 }); await snapshot.assertUnchanged();
    await writeFile(snapshot.path, "new"); await expect(snapshot.assertUnchanged()).rejects.toMatchObject({ code: "NATIVE_FILE_CHANGED" }); snapshot.dispose();
  });
  it.each(["symlink", "hardlink", "directory", "fifo", "mode", "parent-link", "parent-mode"])("rejects unsafe %s without leaking diagnostic paths", async (kind) => {
    const root = await fixture(), other = join(root, "private-canary"); await mkdir(join(root, "rules"), { mode: 0o700 });
    const path = join(root, "rules", "guide.md"); await writeFile(other, "secret", { mode: 0o600 });
    if (kind === "symlink") await symlink(other, path);
    if (kind === "hardlink") await link(other, path);
    if (kind === "directory") await mkdir(path);
    if (kind === "fifo") await promisify(execFile)("mkfifo", [path]);
    if (kind === "mode") { await writeFile(path, "x"); await chmod(path, 0o666); }
    if (kind === "parent-link") { await rm(join(root, "rules"), { recursive: true }); await symlink(root, join(root, "rules")); }
    if (kind === "parent-mode") await chmod(join(root, "rules"), 0o777);
    await expect(readNativeFileSnapshot(root, "rules/guide.md")).rejects.toMatchObject({ code: "NATIVE_FILE_UNSAFE" });
    try { await readNativeFileSnapshot(root, "rules/guide.md"); } catch (error) { expect(String(error)).not.toContain("canary"); }
  });
  it("refuses unsafe paths, oversize files and modifications during descriptor reads", async () => {
    const root = await fixture();
    for (const path of ["", "/outside", "../outside", "rules//x", "rules/./x", "rules\\x", "bad\0name"]) await expect(readNativeFileSnapshot(root, path)).rejects.toThrow();
    const path = join(root, "guide.md"); await writeFile(path, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
    await expect(readNativeFileSnapshot(root, "guide.md")).rejects.toMatchObject({ code: "NATIVE_FILE_UNSAFE" });
    await writeFile(path, "original");
    await expect(readNativeFileSnapshot(root, "guide.md", { afterRead: async () => { await writeFile(path, "changed!"); } })).rejects.toMatchObject({ code: "NATIVE_FILE_CHANGED" });
  });
  it("detects replacement of a parent even when it retains the same file inode", async () => {
    const root = await fixture(); await mkdir(join(root, "rules"), { mode: 0o700 }); await writeFile(join(root, "rules", "guide.md"), "x", { mode: 0o600 });
    const snapshot = await readNativeFileSnapshot(root, "rules/guide.md");
    await rename(join(root, "rules"), join(root, "old")); await mkdir(join(root, "rules"), { mode: 0o700 }); await rename(join(root, "old", "guide.md"), snapshot.path);
    await expect(snapshot.assertUnchanged()).rejects.toMatchObject({ code: "NATIVE_FILE_CHANGED" }); snapshot.dispose();
  });
});
