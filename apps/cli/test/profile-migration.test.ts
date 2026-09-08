import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.js";
import { decodeProfile, PROFILE_MAGIC } from "../src/profile-format.js";
import { ProfileLock } from "@statecase/runtime";
import { HarnessActivityRegistry } from "../src/activity.js";
import { runCli } from "../src/bin.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "statecase-profile-upgrade-")); roots.push(root);
  const config = { version: 1, apiUrl: "https://fixture.test", mappings: [], workspaces: [], applied: {}, extra: { preserve: "optional" } };
  const text = JSON.stringify(config, null, 3) + "\n";
  await writeFile(join(root, "config.json"), text, { mode: 0o600 });
  return { root, text, config, store: new ConfigStore(root) };
}
describe("explicit local profile upgrade (PR-014, RT-017)", () => {
  it("preserves a pre-existing staging collision and redacts write failures", async () => {
    const f = await fixture(); await f.store.upgradeProfile({ dryRun: false });
    const config = await f.store.loadConfig(), original = await readFile(join(f.root, "config.json"));
    const id = "11111111-1111-4111-8111-111111111111";
    const collision = join(f.root, `config.json.${process.pid}.${id}.tmp`);
    await writeFile(collision, "existing-private-canary", { mode: 0o600 });
    const mock = vi.spyOn(crypto, "randomUUID").mockReturnValue(id);
    try { await expect(f.store.saveConfig(config)).rejects.toMatchObject({ code: "PROFILE_WRITE_FAILED", message: expect.not.stringContaining(f.root) }); }
    finally { mock.mockRestore(); }
    expect(await readFile(collision, "utf8")).toBe("existing-private-canary");
    expect(await readFile(join(f.root, "config.json"))).toEqual(original);
  });
  it("retains the source and completed backup after a precommit I/O failure", async () => {
    const f = await fixture();
    await expect(f.store.upgradeProfile({ dryRun: false, beforeCommit: async () => { throw new Error("private-io-canary"); } }))
      .rejects.toMatchObject({ code: "PROFILE_WRITE_FAILED", message: expect.not.stringContaining("private-io-canary") });
    expect(await readFile(join(f.root, "config.json"), "utf8")).toBe(f.text);
    const backups = (await readdir(f.root)).filter((name) => name.startsWith("config.pre-upgrade-v1."));
    expect(backups).toHaveLength(1); expect(await readFile(join(f.root, backups[0]!), "utf8")).toBe(f.text);
  });
  it("keeps an absent profile absent during status, preview and no-op upgrade", async () => {
    const f = await fixture(), path = join(f.root, "absent");
    const store = new ConfigStore(path);
    expect(await store.profileStatus()).toEqual({ exists: false, format: 2, migrationRequired: false });
    expect(await store.upgradeProfile({ dryRun: false })).toMatchObject({ changed: false });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses a tracked active supervisor and a changed source after backup, preserving both versions", async () => {
    const f = await fixture(), registry = new HarnessActivityRegistry(join(f.root, "locks", "harnesses"));
    const active = await registry.enter("codex");
    try { await expect(f.store.upgradeProfile({ dryRun: false })).rejects.toMatchObject({ code: "CONFIG_STATE_CHANGED" }); }
    finally { await active.release(); }
    const changed = JSON.stringify({ ...f.config, deviceName: "newer-edit" });
    await expect(f.store.upgradeProfile({ dryRun: false, beforeCommit: () => writeFile(join(f.root, "config.json"), changed) }))
      .rejects.toMatchObject({ code: "CONFIG_STATE_CHANGED" });
    expect(await readFile(join(f.root, "config.json"), "utf8")).toBe(changed);
    const backups = (await readdir(f.root)).filter((name) => name.startsWith("config.pre-upgrade-v1."));
    expect(backups).toHaveLength(1); expect(await readFile(join(f.root, backups[0]!), "utf8")).toBe(f.text);
    expect((await stat(join(f.root, backups[0]!))).mode & 0o777).toBe(0o600);
  });
  it("invalidates a legacy reader's pending configuration write after migration", async () => {
    const f = await fixture(), reader = new ConfigStore(f.root);
    const stale = await reader.loadConfig({ allowLegacy: true });
    await expect(reader.saveConfig(stale)).rejects.toMatchObject({ code: "PROFILE_UPGRADE_REQUIRED" });
    await f.store.upgradeProfile({ dryRun: false });
    const before = await readFile(join(f.root, "config.json"));
    stale.deviceName = "stale";
    await expect(reader.saveConfig(stale)).rejects.toMatchObject({ code: "CONFIG_STATE_CHANGED" });
    expect(await readFile(join(f.root, "config.json"))).toEqual(before);
  });
  it.each(["symlink", "hardlink", "directory", "writable", "oversized", "utf8", "root-symlink"])("rejects unsafe %s input without migration", async (kind) => {
    const f = await fixture(), path = join(f.root, "config.json");
    if (kind === "symlink") { await rm(path); await symlink(join(f.root, "outside"), path); }
    if (kind === "hardlink") await link(path, join(f.root, "alias"));
    if (kind === "directory") { await rm(path); await mkdir(path); }
    if (kind === "writable") await chmod(path, 0o666);
    if (kind === "oversized") await truncate(path, 16 * 1024 * 1024 + 1);
    if (kind === "utf8") await writeFile(path, Uint8Array.of(255));
    let store = f.store;
    if (kind === "root-symlink") { const alias = join(f.root, "root-link"); await symlink(f.root, alias); store = new ConfigStore(alias); }
    await expect(store.upgradeProfile({ dryRun: false })).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    expect((await readdir(f.root)).filter((name) => name.startsWith("config.pre-upgrade"))).toEqual([]);
  });
  it("exposes CLI preview/confirmation and refuses legacy operations before credentials, network or native writes", async () => {
    const f = await fixture(), previous = process.env.STATECASE_HOME;
    process.env.STATECASE_HOME = f.root;
    const stdout: string[] = [], stderr: string[] = [];
    const command = (...args: string[]) => runCli(["node", "statecase", "--json", ...args], {
      stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value), fetch: async () => { throw new Error("unexpected network"); },
    });
    try {
      expect(await command("profile", "status")).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toEqual({ exists: true, format: 1, migrationRequired: true });
      for (const args of [["logout"], ["pull"], ["skills", "install", "--target", join(f.root, "native")], ["credentials", "protect", "--yes"]]) {
        expect(await command(...args)).toBe(6);
        expect(JSON.parse(stderr.at(-1)!)).toMatchObject({ error: { code: 6, message: expect.stringContaining("explicit migration") } });
      }
      await expect(stat(join(f.root, "native"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(f.root, "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await command("profile", "upgrade")).toBe(2);
      expect(await command("profile", "upgrade", "--dry-run", "--yes")).toBe(2);
      expect(await command("profile", "upgrade", "--dry-run")).toBe(0);
      expect(await readFile(join(f.root, "config.json"), "utf8")).toBe(f.text);
      expect(await command("profile", "upgrade", "--yes")).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({ changed: true, fromFormat: 1, toFormat: 2, backupPath: expect.any(String) });
      expect(await command("profile", "status")).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({ format: 2, migrationRequired: false });
    } finally { if (previous === undefined) delete process.env.STATECASE_HOME; else process.env.STATECASE_HOME = previous; }
  });
  it("requires explicit migration before reading a legacy profile for normal use", async () => {
    const f = await fixture();
    await expect(f.store.loadConfig()).rejects.toMatchObject({ code: "PROFILE_UPGRADE_REQUIRED" });
    expect(await readFile(join(f.root, "config.json"), "utf8")).toBe(f.text);
  });
  it("previews without files or secrets access, backs up exact bytes, migrates once and refuses legacy JSON readers", async () => {
    const f = await fixture();
    // A malformed credential file proves migration has no credential dependency.
    await writeFile(join(f.root, "credentials.json"), "private-canary", { mode: 0o600 });
    const before = await readdir(f.root);
    expect(await f.store.upgradeProfile({ dryRun: true })).toMatchObject({ fromFormat: 1, toFormat: 2, changed: true, dryRun: true });
    expect(await readdir(f.root)).toEqual(before);
    expect(await readFile(join(f.root, "config.json"), "utf8")).toBe(f.text);
    const result = await f.store.upgradeProfile({ dryRun: false });
    expect(result).toMatchObject({ fromFormat: 1, toFormat: 2, changed: true, dryRun: false });
    expect(await readFile(result.backupPath!, "utf8")).toBe(f.text);
    const current = await readFile(join(f.root, "config.json"), "utf8");
    expect(current.startsWith(PROFILE_MAGIC)).toBe(true); expect(() => JSON.parse(current)).toThrow();
    expect(decodeProfile(current).config).toEqual(f.config);
    expect(await f.store.loadConfig()).toEqual(f.config);
    expect(await readFile(join(f.root, "credentials.json"), "utf8")).toBe("private-canary");
    expect(await f.store.upgradeProfile({ dryRun: false })).toMatchObject({ fromFormat: 2, changed: false });
    expect(await readFile(join(f.root, "config.json"), "utf8")).toBe(current);
  });
  it.each(["daemon.lock", "config.lock"])("refuses a held %s without changing the legacy document", async (name) => {
    const f = await fixture(), lock = await ProfileLock.acquire(join(f.root, name));
    try { await expect(f.store.upgradeProfile({ dryRun: false })).rejects.toMatchObject({ code: "CONFIG_STATE_CHANGED" }); }
    finally { await lock.release(); }
    expect(await readFile(join(f.root, "config.json"), "utf8")).toBe(f.text);
    expect((await readdir(f.root)).filter((name) => name.startsWith("config.pre-upgrade"))).toEqual([]);
  });
});
