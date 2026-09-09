import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertNoHarnessProcess, HarnessActivityRegistry } from "../src/activity.js";

const temporary: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("harness activity and restore barriers (BK-007)", () => {
  it("rejects invalid owners and supports an empty registry and idempotent release", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-activity-empty-"));
    temporary.push(root);
    expect(() => new HarnessActivityRegistry(root, { pid: 0 })).toThrow("PID is invalid");
    expect(() => new HarnessActivityRegistry(root, { pid: Number.MAX_SAFE_INTEGER + 1 })).toThrow("PID is invalid");

    const registry = new HarnessActivityRegistry(root, { pid: 91, isAlive: () => false });
    const restore = await registry.beginRestore("claude");
    await restore.release();
    const activity = await registry.enter("claude");
    await activity.release();
    await activity.release();
  });

  it("allows concurrent harness runs but refuses restore until every run exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-activity-"));
    temporary.push(root);
    const registry = new HarnessActivityRegistry(root, { pid: 101, isAlive: (pid) => pid === 101 || pid === 102 });
    const first = await registry.enter("codex");
    const second = await new HarnessActivityRegistry(root, { pid: 102, isAlive: (pid) => pid === 101 || pid === 102 }).enter("codex");

    await expect(registry.beginRestore("codex")).rejects.toThrow("active");
    await first.release();
    await expect(registry.beginRestore("codex")).rejects.toThrow("active");
    await second.release();

    const restore = await registry.beginRestore("codex");
    await expect(registry.enter("codex")).rejects.toThrow("restore");
    await restore.release();
    const resumed = await registry.enter("codex");
    await resumed.release();
  });

  it("removes stale valid markers but fails closed on malformed activity state", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-activity-stale-"));
    temporary.push(root);
    const stale = new HarnessActivityRegistry(root, { pid: 201, isAlive: () => false });
    await stale.enter("claude");
    const restore = await stale.beginRestore("claude");
    await restore.release();

    const markerDirectory = join(root, "active", "claude");
    await writeFile(join(markerDirectory, "malformed.json"), "not-json", { mode: 0o600 });
    await expect(stale.beginRestore("claude")).rejects.toThrow("invalid harness activity marker");
  });

  it("fails closed when marker ownership or the activity directory changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-activity-owner-"));
    temporary.push(root);
    const registry = new HarnessActivityRegistry(root, { pid: 301, isAlive: () => false });
    const activity = await registry.enter("codex");
    const directory = join(root, "active", "codex");
    const [name] = await readdir(directory);
    await writeFile(join(directory, name!), JSON.stringify({ version: 1, pid: 301, token: crypto.randomUUID() }));
    await expect(activity.release()).rejects.toThrow("ownership changed");

    const brokenRoot = await mkdtemp(join(tmpdir(), "statecase-activity-directory-"));
    temporary.push(brokenRoot);
    await mkdir(join(brokenRoot, "active"));
    await writeFile(join(brokenRoot, "active", "claude"), "not a directory");
    await expect(new HarnessActivityRegistry(brokenRoot, { pid: 302, isAlive: () => false }).beginRestore("claude"))
      .rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("uses the operating-system liveness check by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-activity-live-"));
    temporary.push(root);
    const registry = new HarnessActivityRegistry(root, { pid: process.pid });
    await registry.enter("claude");
    await expect(registry.beginRestore("claude")).rejects.toThrow(`PID ${process.pid}`);

    const staleRoot = await mkdtemp(join(tmpdir(), "statecase-activity-dead-"));
    temporary.push(staleRoot);
    const staleRegistry = new HarnessActivityRegistry(staleRoot, { pid: 2_000_000_000 });
    await staleRegistry.enter("claude");
    const staleRestore = await staleRegistry.beginRestore("claude");
    await staleRestore.release();
  });

  it("detects native and Node-launched harnesses without echoing their arguments", async () => {
    const table = [
      "  10 codex /usr/local/bin/codex --resume secret-session",
      "  11 node /opt/@anthropic-ai/claude-code/cli.js --prompt secret-prompt",
      "  12 bash bash -c echo codex",
      "  13 statecase statecase restore",
    ].join("\n");
    await expect(assertNoHarnessProcess("codex", { currentPid: 13, processTable: async () => table }))
      .rejects.toThrow("PID 10");
    await expect(assertNoHarnessProcess("claude", { currentPid: 13, processTable: async () => table }))
      .rejects.toThrow("PID 11");
    await expect(assertNoHarnessProcess("claude", { currentPid: 11, processTable: async () => table }))
      .resolves.toBeUndefined();
    try {
      await assertNoHarnessProcess("codex", { currentPid: 13, processTable: async () => table });
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-session");
    }
  });

  it("ignores malformed and invalid process rows and recognizes supported executable forms", async () => {
    const table = [
      "not a process row",
      "  0 codex codex",
      "  9007199254740993 claude claude",
      "  21 codex-helper /usr/bin/codex-helper",
      "  20 node C:\\tools\\codex --resume hidden",
      "  22 node /opt/@openai/codex/bin/codex.js --resume hidden",
    ].join("\n");
    await expect(assertNoHarnessProcess("codex", { currentPid: 999, processTable: async () => table }))
      .rejects.toThrow("PID 20, 21, 22");
    await expect(assertNoHarnessProcess("claude", { currentPid: 999, processTable: async () => table }))
      .resolves.toBeUndefined();
  });

  it("can inspect the system process table without requiring an injected reader", async () => {
    const outcome = await assertNoHarnessProcess("claude", { currentPid: process.pid })
      .then(() => "available", (error: Error) => error.message);
    expect(outcome === "available" || outcome === "could not verify that the harness is stopped" ||
      /^claude harness is active with PID [0-9, ]+$/u.test(outcome)).toBe(true);
  });
});
