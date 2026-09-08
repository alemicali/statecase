import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { codexSettingsDocument } from "@statecase/adapter-codex/config";
import { readSettingsSnapshot } from "../src/settings-file.js";
import { applyFileTransaction } from "../src/materialize.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "statecase-settings-file-")); roots.push(root);
  const path = join(root, "config.toml");
  await writeFile(path, 'model="fixture"\nsecret="local-canary"\n[tui]\nanimations=false\n', { mode: 0o600 });
  return { root, path };
}

describe("safe native configuration observation (AD-CFG-006)", () => {
  it("projects once, prepares one owner-only write and retains local-only bytes", async () => {
    const { root, path } = await fixture();
    const snapshot = await readSettingsSnapshot(root, codexSettingsDocument);
    try {
      expect(snapshot.entries).toHaveLength(2);
      expect(JSON.stringify(snapshot.entries)).not.toContain("canary");
      const patched = snapshot.patch([{ key: "model", value: "new" }, { key: "tui.animations", value: true }]);
      expect(await readFile(path, "utf8")).toContain('model="fixture"');
      await applyFileTransaction({ writes: [{ path: snapshot.path, bytes: patched, mode: 0o600 }], deletes: [], beforeCommit: () => snapshot.assertUnchanged() });
      expect(await readFile(path, "utf8")).toBe('model="new"\nsecret="local-canary"\n[tui]\nanimations=true\n');
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect((await readdir(root)).some((name) => name.includes("transaction"))).toBe(false);
      patched.fill(0);
    } finally { snapshot.dispose(); }
    expect(() => snapshot.patch([])).toThrow();
    await expect(snapshot.assertUnchanged()).rejects.toThrow();
    snapshot.dispose();
  });

  it.each(["change-secret", "replace-inode", "delete", "change-mode", "replace-root"])("refuses a concurrent %s, including changes outside portable fields", async (mutation) => {
    const { root, path } = await fixture();
    const snapshot = await readSettingsSnapshot(root, codexSettingsDocument);
    try {
      if (mutation === "change-secret") await writeFile(path, 'model="fixture"\nsecret="updated-canary"\n[tui]\nanimations=false\n');
      if (mutation === "replace-inode") { await writeFile(join(root, "replacement"), await readFile(path), { mode: 0o600 }); await rename(join(root, "replacement"), path); }
      if (mutation === "delete") await rm(path);
      if (mutation === "change-mode") await chmod(path, 0o644);
      if (mutation === "replace-root") {
        const moved = root + "-moved"; roots.push(moved);
        await rename(root, moved); await mkdir(root, { mode: 0o700 }); await writeFile(path, await readFile(join(moved, "config.toml")), { mode: 0o600 });
      }
      await expect(snapshot.assertUnchanged()).rejects.toMatchObject({ code: "CONFIG_FILE_CHANGED" });
    } finally { snapshot.dispose(); }
  });

  it.each(["symlink", "hardlink", "directory", "fifo", "writable", "oversized", "root-link", "root-writable"])("rejects unsafe %s without reading secret bytes or hanging", async (kind) => {
    const { root, path } = await fixture();
    let selected = root;
    if (kind === "symlink") { await rename(path, join(root, "secret")); await symlink("secret", path); }
    if (kind === "hardlink") await link(path, join(root, "second-link"));
    if (kind === "directory" || kind === "fifo") {
      await rm(path);
      if (kind === "directory") await mkdir(path);
      else await promisify(execFile)("mkfifo", [path]);
    }
    if (kind === "writable") await chmod(path, 0o666);
    if (kind === "oversized") await writeFile(path, " ".repeat(1024 * 1024 + 1));
    if (kind === "root-link") { selected = root + "-link"; roots.push(selected); await symlink(root, selected); }
    if (kind === "root-writable") await chmod(root, 0o777);
    await expect(readSettingsSnapshot(selected, codexSettingsDocument)).rejects.toMatchObject({ code: "CONFIG_FILE_UNSAFE" });
  });

  it("detects source changes while reading, without returning a stale projection", async () => {
    const { root, path } = await fixture();
    await expect(readSettingsSnapshot(root, codexSettingsDocument, { afterRead: async () => { await writeFile(path, 'model="changed"'); } }))
      .rejects.toMatchObject({ code: "CONFIG_FILE_CHANGED" });
  });

  it("handles absent roots/files without preview mutations and refuses newly appeared content", async () => {
    const { root } = await fixture();
    const target = join(root, "new-root");
    const snapshot = await readSettingsSnapshot(target, codexSettingsDocument);
    try {
      expect(snapshot.entries).toEqual([]);
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      await snapshot.assertUnchanged();
      const patched = snapshot.patch([{ key: "model", value: "fresh" }]);
      await applyFileTransaction({ writes: [{ path: snapshot.path, bytes: patched, mode: 0o600 }], deletes: [], beforeCommit: () => snapshot.assertUnchanged() });
      expect(await readFile(snapshot.path, "utf8")).toContain('"model" = "fresh"');
      await expect(snapshot.assertUnchanged()).rejects.toMatchObject({ code: "CONFIG_FILE_CHANGED" });
      patched.fill(0);
    } finally { snapshot.dispose(); }
  });

  it("rolls back a prior config replacement when a later config changed during staging", async () => {
    const a = await fixture(), b = await fixture();
    const first = await readSettingsSnapshot(a.root, codexSettingsDocument), second = await readSettingsSnapshot(b.root, codexSettingsDocument);
    const before = await readFile(a.path);
    const edits = [first, second].map((snapshot) => ({ path: snapshot.path, bytes: snapshot.patch([{ key: "model", value: "remote" }]), mode: 0o600 }));
    try {
      await expect(applyFileTransaction({ writes: edits, deletes: [], beforeCommit: async (index) => {
        if (index === 1) await writeFile(b.path, 'model="local-editor"\nsecret="new-canary"');
        await [first, second][index]!.assertUnchanged();
      } })).rejects.toMatchObject({ code: "CONFIG_FILE_CHANGED" });
      expect(await readFile(a.path)).toEqual(before);
      expect(await readFile(b.path, "utf8")).toContain("local-editor");
    } finally { first.dispose(); second.dispose(); for (const edit of edits) edit.bytes.fill(0); }
  });
});
