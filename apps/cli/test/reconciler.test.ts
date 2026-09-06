import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalStateStore } from "@statecase/storage-local";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableReconciler } from "../src/reconciler.js";

const stores: LocalStateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("durable runtime reconciliation (RT-004..RT-006)", () => {
  it("journals before synchronization and commits only after success", async () => {
    const store = openStore();
    const sync = vi.fn(async () => "rev_one");
    const reconciler = new DurableReconciler(store, sync, "codex");

    await reconciler.reconcile("final");

    expect(sync).toHaveBeenCalledWith("final");
    expect(store.pending()).toEqual([]);
  });

  it("retains a redacted queued operation after failure and replays it after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "statecase-reconcile-"));
    const path = join(root, "state.db");
    let store = new LocalStateStore(path);
    stores.push(store);
    const failing = new DurableReconciler(store, async () => {
      throw new Error("request failed with bearer very-secret-token");
    }, "claude");
    await expect(failing.reconcile("periodic")).rejects.toThrow("synchronization is queued");
    expect(store.pending()[0]).toMatchObject({
      kind: "runtime-reconcile",
      state: "queued",
      attempts: 1,
      lastError: "synchronization failed",
      payload: { harness: "claude", reason: "periodic" },
    });
    expect(JSON.stringify(store.pending())).not.toContain("very-secret-token");

    store.close();
    stores.pop();
    store = new LocalStateStore(path);
    stores.push(store);
    const recovered = new DurableReconciler(store, async () => "rev_recovered", "claude");
    await recovered.reconcile("preflight");
    expect(store.pending()).toEqual([]);
  });

  it("fails closed on a malformed persisted runtime operation", async () => {
    const store = openStore();
    store.enqueue({ id: "bad", kind: "runtime-reconcile", payload: { harness: "unknown", reason: "never" } });
    await expect(new DurableReconciler(store, async () => "rev", "codex").reconcile("final"))
      .rejects.toThrow("synchronization is queued");
    expect(store.getOperation("bad")).toMatchObject({ state: "queued", attempts: 1 });
  });
});

function openStore(): LocalStateStore {
  const root = mkdtempSync(join(tmpdir(), "statecase-reconcile-"));
  const store = new LocalStateStore(join(root, "state.db"));
  stores.push(store);
  return store;
}
