import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  HarnessSupervisor,
  resolveHarnessExecutable,
  type HarnessChild,
  type HarnessSpawn,
  type ReconcileReason,
} from "../src/supervisor.js";

class FakeChild extends EventEmitter implements HarnessChild {
  readonly kill = vi.fn(() => true);
}

describe("foreground harness supervisor (RT-002..RT-005, RT-011)", () => {
  it("pulls before launch, preserves stdio and exit code, then performs a final flush", async () => {
    const events: string[] = [];
    const child = new FakeChild();
    const spawn: HarnessSpawn = vi.fn((_executable, _arguments, options) => {
      events.push(`spawn:${String(options.stdio)}`);
      queueMicrotask(() => child.emit("exit", 23, null));
      return child;
    });
    const reconcile = vi.fn(async (reason: ReconcileReason) => {
      events.push(`sync:${reason}`);
    });
    const supervisor = new HarnessSupervisor({ spawn, reconcile, intervalMs: 0, preflightTimeoutMs: 0, finalFlushTimeoutMs: 0 });

    const result = await supervisor.run({
      harness: "codex",
      executable: "/opt/codex",
      args: ["--model", "test"],
      cwd: "/work",
      env: { PATH: "/bin" },
    });

    expect(result.exitCode).toBe(23);
    expect(events).toEqual(["sync:preflight", "spawn:inherit", "sync:final"]);
    expect(spawn).toHaveBeenCalledWith(
      "/opt/codex",
      ["--model", "test"],
      expect.objectContaining({ cwd: "/work", stdio: "inherit", env: expect.objectContaining({ STATECASE_ACTIVE_HARNESS: "codex" }) }),
    );
  });

  it("runs locally when preflight and final network reconciliation fail", async () => {
    const child = new FakeChild();
    const spawn: HarnessSpawn = () => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    };
    const warnings: string[] = [];
    const reconcile = vi.fn(async () => {
      throw new Error("secret-bearing upstream failure");
    });
    const supervisor = new HarnessSupervisor({ spawn, reconcile, intervalMs: 0, warn: (message) => warnings.push(message) });

    const result = await supervisor.run({ harness: "claude", executable: "/opt/claude", args: [], cwd: "/work", env: {} });

    expect(result).toMatchObject({ exitCode: 0, preflight: "queued", finalFlush: "queued" });
    expect(warnings).toEqual([
      "Statecase preflight sync is queued; starting Claude offline.",
      "Statecase final sync is queued and will be retried.",
    ]);
  });

  it("serializes periodic reconciliation and leaves no timer after child exit", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const spawn: HarnessSpawn = () => child;
      let active = 0;
      let maximum = 0;
      const reasons: ReconcileReason[] = [];
      const reconcile = vi.fn(async (reason: ReconcileReason) => {
        reasons.push(reason);
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });
      const supervisor = new HarnessSupervisor({ spawn, reconcile, intervalMs: 50 });
      const running = supervisor.run({ harness: "codex", executable: "/opt/codex", args: [], cwd: "/work", env: {} });
      await vi.advanceTimersByTimeAsync(180);
      child.emit("exit", 0, null);
      await vi.runAllTimersAsync();
      await running;

      expect(maximum).toBe(1);
      expect(reasons).toContain("periodic");
      const count = reconcile.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(reconcile).toHaveBeenCalledTimes(count);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards process signals and converts a signal exit to the shell convention", async () => {
    const child = new FakeChild();
    const spawn: HarnessSpawn = () => child;
    const signals = new EventEmitter();
    const supervisor = new HarnessSupervisor({ spawn, reconcile: async () => {}, intervalMs: 0, signals });
    const running = supervisor.run({ harness: "codex", executable: "/opt/codex", args: [], cwd: "/work", env: {} });
    await new Promise((resolve) => setImmediate(resolve));
    signals.emit("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", null, "SIGTERM");

    expect((await running).exitCode).toBe(143);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("refuses recursive harness execution before performing synchronization", async () => {
    const reconcile = vi.fn();
    const supervisor = new HarnessSupervisor({ spawn: vi.fn(), reconcile, intervalMs: 0 });
    await expect(supervisor.run({
      harness: "codex",
      executable: "/opt/codex",
      args: [],
      cwd: "/work",
      env: { STATECASE_ACTIVE_HARNESS: "codex" },
    })).rejects.toThrow("recursive Codex launch");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("bounds unavailable synchronization and still cleans up after a child spawn error", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const signals = new EventEmitter();
      const supervisor = new HarnessSupervisor({
        spawn: () => {
          queueMicrotask(() => child.emit("error", new Error("spawn failed")));
          return child;
        },
        reconcile: () => new Promise(() => undefined),
        preflightTimeoutMs: 10,
        intervalMs: 25,
        signals,
        warn: () => {},
      });
      const running = supervisor.run({ harness: "codex", executable: "/missing", args: [], cwd: "/work", env: {} });
      const rejected = expect(running).rejects.toThrow("spawn failed");
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
      expect(signals.listenerCount("SIGINT")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates intervals and resolves a real executable while skipping an excluded shim", async () => {
    expect(() => new HarnessSupervisor({ reconcile: async () => {} })).not.toThrow();
    expect(() => new HarnessSupervisor({ reconcile: async () => {}, intervalMs: -1 })).toThrow("sync interval");
    expect(() => new HarnessSupervisor({ reconcile: async () => {}, intervalMs: 1.5 })).toThrow("sync interval");
    const root = await mkdtemp(join(process.cwd(), ".statecase-resolve-"));
    const first = join(root, "first");
    const second = join(root, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    const excluded = join(first, "codex");
    const real = join(second, "codex");
    await Promise.all([writeFile(excluded, "#!/bin/sh\n"), writeFile(real, "#!/bin/sh\n")]);
    await Promise.all([chmod(excluded, 0o700), chmod(real, 0o700)]);

    expect(await resolveHarnessExecutable("codex", { PATH: `${first}:${second}` }, [excluded])).toBe(real);
    expect(await resolveHarnessExecutable(real, {}, [])).toBe(real);
    await expect(resolveHarnessExecutable("claude", { PATH: first }, [])).rejects.toThrow("could not find");
    await rm(root, { recursive: true, force: true });
  });

  it("uses a conservative exit code for an unmapped child signal", async () => {
    const child = new FakeChild();
    const supervisor = new HarnessSupervisor({
      spawn: () => {
        queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
        return child;
      },
      reconcile: async () => {},
      intervalMs: 0,
    });
    expect((await supervisor.run({ harness: "claude", executable: "/real", args: [], cwd: "/work", env: {} })).exitCode).toBe(128);
  });

  it("times out both sync boundaries while preserving a normal child exit", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const supervisor = new HarnessSupervisor({
        spawn: () => {
          queueMicrotask(() => child.emit("exit", null, null));
          return child;
        },
        reconcile: () => new Promise(() => undefined),
        intervalMs: 0,
        preflightTimeoutMs: 5,
        finalFlushTimeoutMs: 5,
        warn: () => {},
      });
      const running = supervisor.run({ harness: "codex", executable: "/real", args: [], cwd: "/work", env: {} });
      await vi.advanceTimersByTimeAsync(6);
      await vi.advanceTimersByTimeAsync(6);
      expect(await running).toMatchObject({ exitCode: 1, preflight: "queued", finalFlush: "queued" });
    } finally {
      vi.useRealTimers();
    }
  });
});
