import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProfileLock, ReconcileScheduler } from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persistent runtime lock (RT-006, RT-007)", () => {
  it("uses the kernel mutex rather than a reused PID for v2 records but respects live legacy owners (RT-016)", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-lock-pid-reuse-")); temporary.push(root);
    const path = join(root, "daemon.lock");
    await writeFile(path, JSON.stringify({ version: 2, pid: process.pid, token: "reused-pid", createdAt: 1 }), { mode: 0o600 });
    const recovered = await ProfileLock.acquire(path);
    expect(recovered.record.version).toBe(2); await recovered.release();
    await writeFile(path, JSON.stringify({ version: 1, pid: process.pid, token: "legacy-live", createdAt: 1 }), { mode: 0o600 });
    await expect(ProfileLock.acquire(path)).rejects.toThrow("already running");
    expect(JSON.parse(await readFile(path, "utf8")).token).toBe("legacy-live");
  });

  it("preserves independent ownership changes during recovery and releases the kernel mutex on failure (RT-016)", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-lock-change-")); temporary.push(root);
    const path = join(root, "daemon.lock");
    await writeFile(path, JSON.stringify({ version: 1, pid: 999, token: "stale", createdAt: 1 }), { mode: 0o600 });
    const replacement = JSON.stringify({ version: 1, pid: 998, token: "independent", createdAt: 2 });
    await expect(ProfileLock.acquire(path, { isAlive: () => false,
      beforeStaleRecovery: async () => { await writeFile(path, replacement); } })).rejects.toThrow("ownership changed");
    expect(await readFile(path, "utf8")).toBe(replacement);
    const retry = await ProfileLock.acquire(path, { isAlive: () => false }); await retry.release();
    await expect(ProfileLock.acquire(path, { beforePublish: async () => { throw new Error("fixture abort"); } })).rejects.toThrow("fixture abort");
    expect(await readdir(root)).toEqual(["daemon.lock.statecase-lock.sqlite"]);
    const afterAbort = await ProfileLock.acquire(path); await afterAbort.release();
  });

  it("refuses linked and oversized owner metadata before reclaiming anything (RT-016)", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-lock-unsafe-")); temporary.push(root);
    const path = join(root, "daemon.lock"), target = join(root, "other");
    const original = JSON.stringify({ version: 1, pid: 999, token: "other-owner", createdAt: 1 });
    await writeFile(target, original, { mode: 0o600 }); await symlink(target, path);
    await expect(ProfileLock.acquire(path, { isAlive: () => false })).rejects.toThrow("invalid existing runtime lock");
    expect(await readFile(target, "utf8")).toBe(original);
    const { rm } = await import("node:fs/promises"); await rm(path);
    await writeFile(path, JSON.stringify({ version: 1, pid: 999, token: "x".repeat(5000), createdAt: 1 }), { mode: 0o600 });
    await expect(ProfileLock.acquire(path, { isAlive: () => false })).rejects.toThrow("invalid existing runtime lock");
  });

  it("never steals a replacement lock when two stale-lock recoveries overlap (RT-016, AU-013)", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-lock-race-")); temporary.push(root);
    const path = join(root, "daemon.lock");
    await writeFile(path, JSON.stringify({ version: 1, pid: 999, token: "stale", createdAt: 1 }), { mode: 0o600 });
    let reached!: () => void, resume!: () => void;
    const atRecovery = new Promise<void>((accept) => { reached = accept; });
    const paused = new Promise<void>((accept) => { resume = accept; });
    const aPromise = ProfileLock.acquire(path, { pid: 100, isAlive: (pid) => pid !== 999,
      beforeStaleRecovery: async () => { reached(); await paused; } });
    await atRecovery;
    let b: ProfileLock | undefined; let bFailure: unknown; let a: ProfileLock | undefined;
    try {
      b = await ProfileLock.acquire(path, { pid: 200, isAlive: (pid) => pid !== 999 }).catch((error: unknown) => { bFailure = error; return undefined; });
      resume(); a = await aPromise;
      expect(b).toBeUndefined(); expect(bFailure).toBeInstanceOf(Error);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: 100, token: a.record.token });
    } finally {
      resume(); a ??= await aPromise.catch(() => undefined);
      await a?.release().catch(() => undefined); await b?.release().catch(() => undefined);
    }
  });

  it("allows one owner, rejects a live second owner, and releases idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-lock-"));
    temporary.push(root);
    const path = join(root, "daemon.lock");
    const first = await ProfileLock.acquire(path, { pid: 100, isAlive: (pid) => pid === 100 });
    await expect(ProfileLock.acquire(path, { pid: 200, isAlive: (pid) => pid === 100 })).rejects.toThrow("already running");
    await first.release();
    await first.release();
    const second = await ProfileLock.acquire(path, { pid: 200, isAlive: () => false });
    await second.release();
  });

  it("recovers a stale lock but never removes a lock whose ownership token changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-stale-lock-"));
    temporary.push(root);
    const path = join(root, "daemon.lock");
    await writeFile(path, JSON.stringify({ version: 1, pid: 999, token: "stale", createdAt: 1 }), { mode: 0o600 });
    const lock = await ProfileLock.acquire(path, { pid: 300, isAlive: () => false });
    const record = JSON.parse(await readFile(path, "utf8")) as { pid: number; token: string };
    expect(record.pid).toBe(300);
    await writeFile(path, JSON.stringify({ version: 1, pid: 301, token: "replacement", createdAt: 2 }));
    await expect(lock.release()).rejects.toThrow("ownership changed");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ token: "replacement" });
  });

  it("fails closed on malformed lock state", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-bad-lock-"));
    temporary.push(root);
    const path = join(root, "daemon.lock");
    await writeFile(path, "not-json");
    await expect(ProfileLock.acquire(path)).rejects.toThrow("invalid existing runtime lock");
  });

  it("validates PIDs, detects the current live process, and tolerates an externally removed owned lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-live-lock-"));
    temporary.push(root);
    const path = join(root, "daemon.lock");
    await expect(ProfileLock.acquire(path, { pid: 0 })).rejects.toThrow("PID is invalid");
    const lock = await ProfileLock.acquire(path);
    await expect(ProfileLock.acquire(path)).rejects.toThrow("already running");
    const { rm } = await import("node:fs/promises");
    await rm(path);
    await lock.release();

    const replacedPath = join(root, "replaced.lock");
    const replaced = await ProfileLock.acquire(replacedPath);
    await rm(replacedPath);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(replacedPath);
    await expect(replaced.release()).rejects.toBeDefined();
  });
});

describe("persistent reconciliation scheduler (RT-008, RT-009)", () => {
  it("debounces hints, honors the maximum interval, polls, and serializes work", async () => {
    vi.useFakeTimers();
    const reasons: string[] = [];
    let active = 0;
    let maximum = 0;
    const scheduler = new ReconcileScheduler(async (reason) => {
      reasons.push(reason);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
    }, { debounceMs: 100, maximumMs: 300, pollMs: 200 });
    scheduler.start();
    scheduler.notify();
    await vi.advanceTimersByTimeAsync(50);
    scheduler.notify();
    await vi.advanceTimersByTimeAsync(100);
    expect(reasons).toContain("filesystem");
    await vi.advanceTimersByTimeAsync(200);
    expect(reasons).toContain("remote-poll");
    expect(reasons).toContain("maximum");
    expect(maximum).toBe(1);
    await scheduler.stop();
    const count = reasons.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(reasons).toHaveLength(count);
  });

  it("backs off after failure, flushes on demand, and resets after recovery", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const scheduler = new ReconcileScheduler(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
    }, { debounceMs: 10, maximumMs: 1000, pollMs: 1000, retryMinimumMs: 50, retryMaximumMs: 200, jitter: () => 0 });
    scheduler.start();
    scheduler.notify();
    await vi.advanceTimersByTimeAsync(11);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(attempts).toBe(2);
    await scheduler.flush();
    expect(attempts).toBe(3);
    await scheduler.stop();
  });

  it("ignores hints before start, starts idempotently, clamps jitter, and validates timing", async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn(async () => { throw new Error("offline"); });
    expect(() => new ReconcileScheduler(reconcile, { debounceMs: 0 })).toThrow("positive integer");
    const scheduler = new ReconcileScheduler(reconcile, {
      debounceMs: 10,
      maximumMs: 1000,
      pollMs: 1000,
      retryMinimumMs: 20,
      retryMaximumMs: 20,
      jitter: () => 99,
    });
    scheduler.notify();
    expect(reconcile).not.toHaveBeenCalled();
    scheduler.start();
    scheduler.start();
    scheduler.notify();
    await vi.advanceTimersByTimeAsync(11);
    expect(reconcile).toHaveBeenCalledTimes(1);
    scheduler.notify();
    await vi.advanceTimersByTimeAsync(10);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(21);
    expect(reconcile.mock.calls.length).toBeGreaterThan(2);
    await scheduler.stop();
  });
});
