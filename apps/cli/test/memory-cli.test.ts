import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.js";
import { runCli, type CliIO } from "../src/bin.js";
import { HarnessActivityRegistry } from "../src/activity.js";
import * as memorySync from "../src/memory-sync.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "statecase-memory-cli-")); roots.push(root);
  vi.stubEnv("STATECASE_HOME", join(root, "profile"));
  vi.stubEnv("HOME", root);
  const store = new ConfigStore(), config = await store.loadConfig();
  config.mappings = [{ id: "codex", name: "Codex", namespace: "harness:codex:default", kind: "codex", mode: "two-way", path: join(root, "codex") },
    { id: "claude", name: "Claude", namespace: "harness:claude:default", kind: "claude", mode: "two-way", path: join(root, "claude") }];
  config.workspaces = [{ id: "ws_test", path: join(root, "project"), sync: "identity-only" }];
  await store.saveConfig(config);
  const output: string[] = [], errors: string[] = [], remote = vi.fn<typeof fetch>().mockRejectedValue(new Error("unexpected remote access"));
  const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch: remote };
  return { root, store, output, errors, remote, command: (...args: string[]) => runCli(["node", "statecase", "--json", "memory", ...args], io),
    cli: (...args: string[]) => runCli(["node", "statecase", "--json", ...args], io), result: () => JSON.parse(output.at(-1)!) };
}

describe("programmatic memory management (AD-MEM-007)", () => {
  it("reports malformed command invocations as usage errors, not internal failures", async () => {
    const f = await fixture();
    for (const args of [["map"], ["map", "recall"], ["list", "--unknown"], ["remove"]]) expect(await f.command(...args)).toBe(2);
    expect(f.errors).toHaveLength(4);
    for (const error of f.errors) expect(JSON.parse(error)).toMatchObject({ error: { code: 2, message: expect.any(String) } });
  });
  it("previews, maps, lists, rebinds and removes a collection without moving native files or contacting cloud", async () => {
    const f = await fixture(), source = join(f.root, "memory"), target = join(f.root, "different-memory");
    await mkdir(source, { mode: 0o700 }); await writeFile(join(source, "MEMORY.md"), "private recall canary", { mode: 0o600 });
    const args = ["map", "recall", source, "--kind", "codex-global", "--harness", "harness:codex:default"];
    const before = await readFile(join(f.store.home, "config.json"));
    expect(await f.command(...args)).toBe(2);
    expect(await f.command(...args, "--dry-run", "--yes")).toBe(2);
    expect(await f.command(...args, "--dry-run")).toBe(0);
    expect(f.result()).toMatchObject({ dryRun: true, changed: true, files: 1, bytes: 21, nativeLocationVerified: false });
    expect(await readFile(join(f.store.home, "config.json"))).toEqual(before);
    expect(await f.command(...args, "--yes")).toBe(0);
    expect(await f.command("list")).toBe(0);
    expect(f.result().memories).toEqual([expect.objectContaining({ id: "recall", namespace: "memory:recall", path: source })]);
    const config = await f.store.loadConfig(); config.applied["memory:recall"] = { revisionId: "nrev_applied", digests: { "portable-memory/v1/MEMORY.md": "obj_digest" } }; await f.store.saveConfig(config);
    expect(await f.command("map", "recall", source, "--yes")).toBe(0);
    expect(f.result().changed).toBe(false); expect((await f.store.loadConfig()).applied).toEqual(config.applied);
    expect(await f.command("map", "recall", source, "--name", "My recall", "--mode", "consume", "--yes")).toBe(0);
    expect((await f.store.loadConfig()).applied).toEqual(config.applied);
    expect(await f.command("map", "recall", target, "--dry-run")).toBe(0); expect(f.result().appliedReset).toBe(true);
    expect((await f.store.loadConfig()).memories![0]!.path).toBe(source);
    expect(await f.command("map", "recall", target, "--yes")).toBe(0);
    expect((await f.store.loadConfig()).applied["memory:recall"]).toBeUndefined();
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    const mapped = await readFile(join(f.store.home, "config.json"));
    expect(await f.command("remove", "recall", "--dry-run")).toBe(0);
    expect(await readFile(join(f.store.home, "config.json"))).toEqual(mapped);
    expect(await f.command("remove", "recall")).toBe(2);
    expect(await f.command("remove", "recall", "--yes")).toBe(0);
    expect((await f.store.loadConfig()).memories).toEqual([]);
    expect(await f.command("remove", "recall", "--yes")).toBe(2);
    expect(await readFile(join(source, "MEMORY.md"), "utf8")).toBe("private recall canary");
    expect(f.remote).not.toHaveBeenCalled(); expect([...f.output, ...f.errors].join("\n")).not.toContain("private recall canary");
  });
  it("requires category and logical ownership, preserves immutable identity and rejects inverse Drop overlap", async () => {
    const f = await fixture(), path = join(f.root, "recall");
    for (const args of [[], ["--kind", "claude-project"], ["--kind", "codex-global", "--harness", "missing"],
      ["--kind", "codex-global", "--harness", "harness:codex:default", "--workspace", "ws_test"]]) {
      expect(await f.command("map", "recall", path, ...args, "--yes")).toBe(2);
    }
    expect(await f.command("map", "recall", path, "--kind", "claude-project", "--harness", "harness:claude:default", "--workspace", "ws_test", "--yes")).toBe(0);
    const before = await readFile(join(f.store.home, "config.json"));
    for (const change of [["--workspace", "ws_other"], ["--kind", "codex-global"], ["--harness", "harness:codex:default"], ["--mode", "invalid"]]) {
      expect(await f.command("map", "recall", path, ...change, "--yes")).toBe(2);
      expect(await readFile(join(f.store.home, "config.json"))).toEqual(before);
    }
    expect(await f.cli("drop", "add", path, "--name", "duplicate-owner")).toBe(2);
    expect(await readFile(join(f.store.home, "config.json"))).toEqual(before);
    expect(await f.command("map", "other", path, "--kind", "claude-project", "--harness", "harness:claude:default", "--workspace", "ws_test", "--yes")).toBe(2);
  });
  it("fails unsafe native enrollment before persisting selection", async () => {
    const f = await fixture(), path = join(f.root, "recall"); await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "unsupported.sqlite"), "synthetic", { mode: 0o600 });
    const before = await readFile(join(f.store.home, "config.json"));
    expect(await f.command("map", "recall", path, "--kind", "codex-global", "--harness", "harness:codex:default", "--yes")).toBe(6);
    expect(await readFile(join(f.store.home, "config.json"))).toEqual(before);
  });
  it("includes selected memory roots in daemon watches and native service permissions (AD-MEM-010)", async () => {
    const f = await fixture(), path = join(f.root, "recall");
    const config = await f.store.loadConfig();
    for (const root of [path, ...config.mappings.map((mapping) => mapping.path), ...config.workspaces.map((workspace) => workspace.path)]) await mkdir(root, { mode: 0o700 });
    expect(await f.command("map", "recall", path, "--kind", "codex-global", "--harness", "harness:codex:default", "--yes")).toBe(0);
    expect(await f.cli("daemon", "foreground", "--once")).toBe(0);
    expect(f.result()).toMatchObject({ roots: 4, queued: true });
    expect(await f.cli("daemon", "install", "--no-start")).toBe(0);
    const definition = await readFile(f.result().path, "utf8");
    if (process.platform === "linux") expect(definition).toContain(`ReadWritePaths="${path}"`);
    expect(f.remote).not.toHaveBeenCalled();
  });
  it("allows agent-driven mapping while an activity marker exists but preserves concurrent configuration changes", async () => {
    const f = await fixture(), path = join(f.root, "recall");
    const activity = await new HarnessActivityRegistry(join(f.store.home, "locks", "harnesses")).enter("codex");
    try {
      const args = ["map", "recall", path, "--kind", "codex-global", "--harness", "harness:codex:default", "--yes"];
      const scan = memorySync.scanMemory;
      vi.spyOn(memorySync, "scanMemory").mockImplementationOnce(async (mapping) => {
        const peer = new ConfigStore(), newer = await peer.loadConfig(); newer.deviceName = "concurrent"; await peer.saveConfig(newer);
        return scan(mapping);
      });
      expect(await f.command(...args)).toBe(5);
      expect((await f.store.loadConfig()).deviceName).toBe("concurrent");
      expect((await f.store.loadConfig()).memories).toBeUndefined();
      expect(await f.command(...args)).toBe(0);
      expect((await f.store.loadConfig()).memories![0]!.id).toBe("recall");
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await activity.release(); }
  });
});
