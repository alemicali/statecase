import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as filesystem from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFileMutex, LocalMutexBusy } from "../src/mutex.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, linkSync: vi.fn(actual.linkSync), lstatSync: vi.fn(actual.lstatSync) };
});

const roots: string[] = []; const held: LocalFileMutex[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const lock of held.splice(0)) lock.release(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "statecase-mutex-")); roots.push(root); return { root, path: join(root, "guard.statecase-lock.sqlite") }; }

describe("native local mutex (RT-016, AU-013)", () => {
  it("handles a competing inode publication and cleans failed unpublished temporary files", async () => {
    const f = fixture(); const original = (await vi.importActual<typeof import("node:fs")>("node:fs")).linkSync;
    const link = vi.spyOn(filesystem, "linkSync").mockImplementationOnce((source, target) => {
      original(source, target); throw Object.assign(new Error("fixture publication race"), { code: "EEXIST" });
    });
    const acquired = LocalFileMutex.acquire(f.path); held.push(acquired);
    expect(statSync(f.path).nlink).toBe(1); acquired.release(); link.mockRestore();
    const other = join(f.root, "failed.statecase-lock.sqlite");
    vi.spyOn(filesystem, "linkSync").mockImplementationOnce(() => { throw Object.assign(new Error("private-path-canary"), { code: "EACCES" }); });
    expect(() => LocalFileMutex.acquire(other)).toThrow("unavailable or unsafe");
    expect(filesystem.readdirSync(f.root)).toEqual(["guard.statecase-lock.sqlite"]);
  });

  it("fails closed on metadata inspection errors and never changes another UID's file", () => {
    const f = fixture();
    vi.spyOn(filesystem, "lstatSync").mockImplementationOnce(() => { throw Object.assign(new Error("private-canary"), { code: "EACCES" }); });
    expect(() => LocalFileMutex.acquire(f.path)).toThrow("unavailable or unsafe");
    vi.restoreAllMocks();
    writeFileSync(f.path, "", { mode: 0o600 }); const owner = statSync(f.path).uid;
    vi.spyOn(process, "getuid").mockReturnValue(owner + 1);
    expect(() => LocalFileMutex.acquire(f.path)).toThrow("unavailable or unsafe");
    expect(statSync(f.path).uid).toBe(owner);
  });

  it("holds a nonblocking exclusive transaction across independent connections and preserves its inode after release", () => {
    const f = fixture(); const first = LocalFileMutex.acquire(f.path); held.push(first);
    const before = statSync(f.path); expect(before.mode & 0o777).toBe(0o600);
    expect(() => LocalFileMutex.acquire(f.path)).toThrow(LocalMutexBusy);
    first.release(); first.release();
    const second = LocalFileMutex.acquire(f.path); held.push(second);
    expect(statSync(f.path).ino).toBe(before.ino); expect(statSync(f.path).size).toBe(0);
    expect(() => LocalFileMutex.acquire(f.path)).toThrow(LocalMutexBusy);
  });

  it("rejects links, permissive files, directories, bad SQLite bytes and unsafe parents with redacted errors", () => {
    const f = fixture(); const other = join(f.root, "private-diagnostic-canary");
    writeFileSync(other, "fixture", { mode: 0o600 }); symlinkSync(other, f.path);
    expect(() => LocalFileMutex.acquire(f.path)).toThrow("unavailable or unsafe"); rmSync(f.path);
    linkSync(other, f.path); expect(() => LocalFileMutex.acquire(f.path)).toThrow("unavailable or unsafe"); rmSync(f.path);
    mkdirSync(f.path); expect(() => LocalFileMutex.acquire(f.path)).toThrow("unavailable or unsafe"); rmSync(f.path, { recursive: true });
    writeFileSync(f.path, "not sqlite", { mode: 0o600 });
    expect(() => LocalFileMutex.acquire(f.path)).toThrow("unavailable or unsafe");
    writeFileSync(f.path, ""); chmodSync(f.path, 0o644);
    expect(() => LocalFileMutex.acquire(f.path)).toThrow("unavailable or unsafe");
    expect(() => LocalFileMutex.acquire(join(other, "guard"))).toThrow("unavailable or unsafe");
    try { LocalFileMutex.acquire(join(other, "guard")); } catch (error) { expect(String(error)).not.toContain("canary"); }
  });
});
