import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyFileTransaction } from "../src/materialize.js";

const temporary: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("transactional native materialization (BK-008, BK-009, WS-025)", () => {
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
