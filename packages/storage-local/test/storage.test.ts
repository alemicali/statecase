import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalStateStore } from "../src/index.js";
import Database from "better-sqlite3";

const stores: LocalStateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function openStore(): { store: LocalStateStore; path: string } {
  const root = mkdtempSync(join(tmpdir(), "statecase-store-"));
  const path = join(root, "state.db");
  const store = new LocalStateStore(path);
  stores.push(store);
  return { store, path };
}

describe("local journal (RT-004..RT-009, SY-009)", () => {
  it("uses WAL, records operations idempotently, and reopens queued work", () => {
    const { store, path } = openStore();
    expect(store.journalMode()).toBe("wal");
    expect(store.enqueue({ id: "op_1", kind: "publish", payload: { revision: "rev_1" } })).toBe(true);
    expect(store.enqueue({ id: "op_1", kind: "publish", payload: { revision: "rev_1" } })).toBe(false);
    store.close();
    stores.pop();

    const reopened = new LocalStateStore(path);
    stores.push(reopened);
    expect(reopened.pending()).toEqual([
      expect.objectContaining({ id: "op_1", kind: "publish", state: "queued", attempts: 0 }),
    ]);
  });

  it("moves operations through claimed, queued retry, and committed states", () => {
    const { store } = openStore();
    store.enqueue({ id: "op_1", kind: "pull", payload: {} });
    expect(store.claimNext("lease_a", 1000)?.state).toBe("running");
    store.retry("op_1", "network unavailable");
    expect(store.pending()[0]).toMatchObject({ state: "queued", attempts: 1, lastError: "network unavailable" });
    store.claimNext("lease_b", 1000);
    store.commit("op_1", "rev_2");
    expect(store.getOperation("op_1")).toMatchObject({ state: "committed", resultRevisionId: "rev_2" });
  });

  it("reclaims expired work but not a live lease", () => {
    const { store } = openStore();
    store.enqueue({ id: "op_1", kind: "pull", payload: {} });
    expect(store.claimNext("lease_a", 100, 1_000)?.leaseUntil).toBe(1_100);
    expect(store.claimNext("lease_b", 100, 1_050)).toBeUndefined();
    expect(store.claimNext("lease_b", 100, 1_101)?.leaseOwner).toBe("lease_b");
  });

  it("rejects invalid transitions and operation fields", () => {
    const { store } = openStore();
    expect(store.getOperation("missing")).toBeUndefined();
    expect(store.claimNext("lease", 100)).toBeUndefined();
    expect(() => store.claimNext("", 100)).toThrow("lease owner");
    expect(() => store.claimNext("lease", 0)).toThrow("lease owner");
    expect(() => store.claimNext("lease", 1.5)).toThrow("lease owner");
    expect(() => store.enqueue({ id: "", kind: "pull", payload: {} })).toThrow("operation ID");
    expect(() => store.enqueue({ id: "op", kind: "", payload: {} })).toThrow("operation kind");
    expect(() => store.enqueue({ id: "op", kind: "pull", payload: undefined })).toThrow("JSON serializable");
    expect(() => store.retry("missing", "safe")).toThrow("not running");
    expect(() => store.commit("missing", "rev")).toThrow("not running");
    expect(() => store.retry("missing", "")).toThrow("redacted error");
    expect(() => store.commit("missing", "")).toThrow("revision ID");
  });

  it("is idempotent when closing and reopening the current schema", () => {
    const { store, path } = openStore();
    expect(store.schemaVersion()).toBe(1);
    store.close();
    store.close();
    stores.pop();
    const reopened = new LocalStateStore(path);
    stores.push(reopened);
    expect(reopened.schemaVersion()).toBe(1);
  });

  it("fails closed on a newer local schema", () => {
    const root = mkdtempSync(join(tmpdir(), "statecase-new-schema-"));
    const path = join(root, "state.db");
    const database = new Database(path);
    database.pragma("user_version = 999");
    database.close();
    expect(() => new LocalStateStore(path)).toThrow("newer than supported");
  });

  it("requires a database path", () => {
    expect(() => new LocalStateStore("")).toThrow("path");
  });

  it("never stores owner-readable database permissions as group/world access on POSIX", () => {
    const { path } = openStore();
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o077).toBe(0);
    }
  });
});
