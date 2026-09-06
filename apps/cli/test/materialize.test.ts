import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
        { path: join(root, "nested", "create.txt"), bytes: new TextEncoder().encode("created") },
      ],
      deletes: [join(root, "delete.txt")],
    });

    expect(await readFile(join(root, "replace.txt"), "utf8")).toBe("new");
    expect(await readFile(join(root, "nested", "create.txt"), "utf8")).toBe("created");
    await expect(readFile(join(root, "delete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).every((name) => !name.includes(".statecase-transaction-"))).toBe(true);
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
    })).rejects.toThrow("duplicate transaction target");
    expect(await readFile(path, "utf8")).toBe("untouched");
  });
});
