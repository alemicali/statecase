import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PersistentRuntime, readRuntimeStatus } from "../src/daemon.js";
import { configuredSyncRoots, type LocalConfig } from "../src/config.js";

const temporary: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persistent daemon runtime (RT-007..RT-010)", () => {
  it("reconciles filesystem events from an explicitly configured external memory root (AD-MEM-010)", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-memory-watch-")); temporary.push(home);
    const path = join(home, "recall"); await mkdir(path, { mode: 0o700 });
    const config: LocalConfig = { version: 1, apiUrl: "https://fixture.invalid", applied: {}, workspaces: [],
      mappings: [{ id: "codex", kind: "codex", name: "Codex", namespace: "harness:codex:default", mode: "consume", path: join(home, "absent-harness") }],
      memories: [{ id: "recall", kind: "codex-global", harnessNamespace: "harness:codex:default", mode: "two-way", path }] };
    const reconcile = vi.fn(async () => undefined);
    const daemon = new PersistentRuntime({ lockPath: join(home, "daemon.lock"), socketPath: join(home, "daemon.sock"),
      roots: configuredSyncRoots(config), reconcile, scheduler: { debounceMs: 10, maximumMs: 10_000, pollMs: 10_000 } });
    try {
      await daemon.start(); expect(daemon.status().roots).toBe(1);
      await writeFile(join(path, "MEMORY.md"), "synthetic memory update", { mode: 0o600 });
      await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith("filesystem"), { timeout: 2000 });
    } finally { await daemon.stop(); }
  });
  it("owns one profile, reconciles missed/events, and exposes private local IPC", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-daemon-"));
    temporary.push(home);
    const root = join(home, "watched");
    await mkdir(root);
    const reconcile = vi.fn(async () => undefined);
    const daemon = new PersistentRuntime({
      lockPath: join(home, "daemon.lock"),
      socketPath: join(home, "daemon.sock"),
      roots: [root],
      reconcile,
      scheduler: { debounceMs: 10, maximumMs: 10_000, pollMs: 10_000 },
    });

    await daemon.start();
    expect(reconcile).toHaveBeenCalledWith("startup");
    await expect(new PersistentRuntime({
      lockPath: join(home, "daemon.lock"),
      socketPath: join(home, "second.sock"),
      roots: [],
      reconcile,
    }).start()).rejects.toThrow("already running");

    await writeFile(join(root, "changed.txt"), "change");
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith("filesystem"), { timeout: 2000 });
    const status = await readRuntimeStatus(join(home, "daemon.sock"));
    expect(status).toMatchObject({ version: 1, running: true, roots: 1, lastTrigger: "filesystem" });
    expect(typeof status.pid).toBe("number");

    await daemon.stop();
    await daemon.stop();
    await expect(readFile(join(home, "daemon.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readRuntimeStatus(join(home, "daemon.sock"), 50)).rejects.toBeDefined();
  });

  it("refuses to replace a non-socket IPC path", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-daemon-socket-"));
    temporary.push(home);
    const socketPath = join(home, "daemon.sock");
    await writeFile(socketPath, "user data");
    const daemon = new PersistentRuntime({ lockPath: join(home, "daemon.lock"), socketPath, roots: [], reconcile: async () => {} });
    await expect(daemon.start()).rejects.toThrow("non-socket IPC path");
    expect(await readFile(socketPath, "utf8")).toBe("user data");
  });

  it("keeps running with queued startup work and reports unavailable roots", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-daemon-offline-"));
    temporary.push(home);
    const warnings: string[] = [];
    const daemon = new PersistentRuntime({
      lockPath: join(home, "daemon.lock"),
      socketPath: join(home, "daemon.sock"),
      roots: [join(home, "missing")],
      reconcile: async () => { throw new Error("offline with secret detail"); },
      warn: (message) => warnings.push(message),
    });
    await daemon.start();
    await daemon.start();
    expect(daemon.status()).toMatchObject({ running: true, queued: true, roots: 0, lastTrigger: "startup" });
    expect(warnings).toEqual([
      "Statecase startup reconciliation is queued.",
      `Statecase is not watching unavailable root: ${join(home, "missing")}`,
    ]);
    expect(warnings.join(" ")).not.toContain("secret detail");
    await daemon.stop();
  });

  it("rejects malformed and timed-out IPC responses", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-daemon-ipc-"));
    temporary.push(home);
    const malformedPath = join(home, "malformed.sock");
    const malformed = createServer((socket) => socket.end("{}\n"));
    await new Promise<void>((resolve) => malformed.listen(malformedPath, resolve));
    await expect(readRuntimeStatus(malformedPath)).rejects.toThrow("invalid daemon status");
    await new Promise<void>((resolve) => malformed.close(() => resolve()));

    const slowPath = join(home, "slow.sock");
    const slow = createServer(() => undefined);
    await new Promise<void>((resolve) => slow.listen(slowPath, resolve));
    await expect(readRuntimeStatus(slowPath, 5)).rejects.toThrow("timed out");
    await new Promise<void>((resolve) => slow.close(() => resolve()));
  });

  it("reports stopped state before start and replaces only a stale socket inode", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-daemon-stale-socket-"));
    temporary.push(home);
    const socketPath = join(home, "daemon.sock");
    const stale = createServer();
    await new Promise<void>((resolve) => stale.listen(socketPath, resolve));
    const daemon = new PersistentRuntime({
      lockPath: join(home, "daemon.lock"),
      socketPath,
      roots: [],
      reconcile: async () => undefined,
    });
    expect(daemon.status()).toMatchObject({ running: false, startedAt: "1970-01-01T00:00:00.000Z" });
    await daemon.start();
    expect((await readRuntimeStatus(socketPath)).running).toBe(true);
    await daemon.stop();
    await new Promise<void>((resolve) => stale.close(() => resolve()));
  });

  it("uses the redacted default warning sink when startup reconciliation is offline", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-daemon-default-warning-"));
    temporary.push(home);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const daemon = new PersistentRuntime({
      lockPath: join(home, "daemon.lock"),
      socketPath: join(home, "daemon.sock"),
      roots: [],
      reconcile: async () => { throw new Error("secret upstream detail"); },
    });
    try {
      await daemon.start();
      expect(stderr).toHaveBeenCalledWith("Statecase startup reconciliation is queued.\n");
      expect(stderr.mock.calls.flat().join(" ")).not.toContain("secret upstream detail");
    } finally {
      await daemon.stop();
      stderr.mockRestore();
    }
  });
});
