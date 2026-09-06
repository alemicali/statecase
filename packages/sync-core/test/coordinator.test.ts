import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { appendOnlyViolations, InMemoryCoordinatorStorage, mergeNamespace, namespaceStateEquals, VaultCoordinatorCore } from "../src/index.js";

const first = {
  protocolVersion: "1.0" as const,
  operationId: "op_01",
  baseRevisionId: null,
  revisionId: "rev_01",
  manifestObjectId: "obj_manifest_01",
  requiredObjectIds: ["obj_a"],
};

describe("ordered vault commits (PR-002..PR-004, PR-010)", () => {
  it("commits the first revision and returns the durable head", async () => {
    const storage = new InMemoryCoordinatorStorage();
    const coordinator = new VaultCoordinatorCore(storage);
    await expect(coordinator.commit(first)).resolves.toEqual({
      outcome: "committed",
      revisionId: "rev_01",
      previousRevisionId: null,
    });
    await expect(coordinator.head()).resolves.toEqual({ revisionId: "rev_01", manifestObjectId: "obj_manifest_01" });
  });

  it("returns the original result for the exact same idempotency payload", async () => {
    const coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
    const original = await coordinator.commit(first);
    expect(await coordinator.commit({ ...first, requiredObjectIds: ["obj_a"] })).toEqual(original);
  });

  it("rejects reuse of an operation ID with a different payload", async () => {
    const coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
    await coordinator.commit(first);
    expect(await coordinator.commit({ ...first, revisionId: "rev_other" })).toEqual({
      outcome: "idempotency-conflict",
    });
    expect(await coordinator.head()).toEqual({ revisionId: "rev_01", manifestObjectId: "obj_manifest_01" });
  });

  it("returns a structured stale-base result without advancing head", async () => {
    const coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
    await coordinator.commit(first);
    expect(
      await coordinator.commit({
        ...first,
        operationId: "op_02",
        baseRevisionId: null,
        revisionId: "rev_02",
      }),
    ).toEqual({ outcome: "stale-base", currentRevisionId: "rev_01" });
    expect(await coordinator.head()).toEqual({ revisionId: "rev_01", manifestObjectId: "obj_manifest_01" });
  });

  it("survives coordinator reconstruction from the same durable storage", async () => {
    const storage = new InMemoryCoordinatorStorage();
    await new VaultCoordinatorCore(storage).commit(first);
    const restarted = new VaultCoordinatorCore(storage);
    expect(await restarted.head()).toEqual({ revisionId: "rev_01", manifestObjectId: "obj_manifest_01" });
    expect(await restarted.commit(first)).toMatchObject({ outcome: "committed", revisionId: "rev_01" });
  });

  it("advances from the exact current base", async () => {
    const coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
    await coordinator.commit(first);
    expect(
      await coordinator.commit({
        ...first,
        operationId: "op_02",
        baseRevisionId: "rev_01",
        revisionId: "rev_02",
        manifestObjectId: "obj_manifest_02",
      }),
    ).toEqual({ outcome: "committed", revisionId: "rev_02", previousRevisionId: "rev_01" });
  });

  it("retains addressable revision pointers after the head advances (BK-001)", async () => {
    const coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
    await coordinator.commit(first);
    await coordinator.commit({ ...first, operationId: "op_02", baseRevisionId: "rev_01", revisionId: "rev_02", manifestObjectId: "obj_manifest_02" });
    expect(await coordinator.revision("rev_01")).toEqual({
      revisionId: "rev_01",
      manifestObjectId: "obj_manifest_01",
      previousRevisionId: null,
    });
    expect(await coordinator.revision("rev_unknown")).toBeNull();
  });

  it("pins and removes protected snapshots without moving the vault head (BK-003, BK-005)", async () => {
    const coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
    await expect(coordinator.createSnapshot({ id: "snp_empty", name: "empty", createdAt: 1 })).resolves.toEqual({ outcome: "no-head" });
    await coordinator.commit(first);
    const created = await coordinator.createSnapshot({ id: "snp_01", name: "Before migration", createdAt: 123 });
    expect(created).toEqual({
      outcome: "created",
      snapshot: {
        id: "snp_01",
        name: "Before migration",
        revisionId: "rev_01",
        manifestObjectId: "obj_manifest_01",
        protected: true,
        createdAt: 123,
      },
    });
    if (created.outcome !== "created") throw new Error("snapshot fixture was not created");
    await coordinator.commit({ ...first, operationId: "op_02", baseRevisionId: "rev_01", revisionId: "rev_02", manifestObjectId: "obj_manifest_02" });
    expect(await coordinator.listSnapshots()).toEqual([created.snapshot]);
    expect(await coordinator.createSnapshot({ id: "snp_01", name: "Before migration", createdAt: 999 })).toEqual(created);
    expect(await coordinator.createSnapshot({ id: "snp_01", name: "different", createdAt: 124 })).toEqual({ outcome: "id-conflict" });
    expect(await coordinator.deleteSnapshot("snp_missing")).toBe(false);
    expect(await coordinator.deleteSnapshot("snp_01")).toBe(true);
    expect(await coordinator.listSnapshots()).toEqual([]);
    expect(await coordinator.head()).toEqual({ revisionId: "rev_02", manifestObjectId: "obj_manifest_02" });
  });
});

describe("atomic namespace heads for scoped capabilities (AU-004..AU-007, PR-003)", () => {
  const update = (namespace: string, revision: string, base: string | null = null) => ({
    namespace,
    baseNamespaceRevisionId: base,
    namespaceRevisionId: revision,
    manifestObjectId: `obj_${revision}`,
    requiredObjectIds: [`chunk_${revision}`],
    mode: "replace" as const,
    pathClaims: [{ pathId: `pth_${revision}`, mutation: "add" as const }],
  });

  it("commits several namespace heads atomically and exposes no unrelated head through selection", async () => {
    const coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
    await expect(coordinator.commitNamespaces({
      protocolVersion: "1.1",
      operationId: "op_namespaces_01",
      vaultRevisionId: "rev_vault_01",
      updates: [update("harness:codex:default", "nrev_harness"), update("workspace:ws_01", "nrev_workspace")],
    })).resolves.toEqual({ outcome: "committed", revisionId: "rev_vault_01", previousRevisionId: null });
    expect(await coordinator.namespaceHeads()).toEqual([
      { namespace: "harness:codex:default", revisionId: "nrev_harness", manifestObjectId: "obj_nrev_harness" },
      { namespace: "workspace:ws_01", revisionId: "nrev_workspace", manifestObjectId: "obj_nrev_workspace" },
    ]);
    expect(await coordinator.namespaceHeads(new Set(["workspace:ws_01"]))).toEqual([
      { namespace: "workspace:ws_01", revisionId: "nrev_workspace", manifestObjectId: "obj_nrev_workspace" },
    ]);
    expect(await coordinator.namespaceRevision("workspace:ws_01", "nrev_workspace")).toEqual({
      namespace: "workspace:ws_01",
      revisionId: "nrev_workspace",
      manifestObjectId: "obj_nrev_workspace",
      previousRevisionId: null,
    });
    expect(await coordinator.namespaceRevision("workspace:ws_01", "nrev_missing")).toBeNull();
    await expect(coordinator.createSnapshot({ id: "snp_scoped", name: "Scoped checkpoint", createdAt: 5 })).resolves.toEqual({
      outcome: "created",
      snapshot: { id: "snp_scoped", name: "Scoped checkpoint", revisionId: "rev_vault_01", protocolVersion: "1.1", protected: true, createdAt: 5 },
    });
  });

  it("allows disjoint offline namespace commits while rejecting a stale touched namespace", async () => {
    const coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
    await coordinator.commitNamespaces({ protocolVersion: "1.1", operationId: "op_a", vaultRevisionId: "rev_a", updates: [update("drop:a", "nrev_a")] });
    await expect(coordinator.commitNamespaces({
      protocolVersion: "1.1", operationId: "op_b", vaultRevisionId: "rev_b", updates: [update("drop:b", "nrev_b")],
    })).resolves.toMatchObject({ outcome: "committed", revisionId: "rev_b", previousRevisionId: "rev_a" });
    await expect(coordinator.commitNamespaces({
      protocolVersion: "1.1", operationId: "op_stale", vaultRevisionId: "rev_stale", updates: [update("drop:a", "nrev_new", null)],
    })).resolves.toEqual({ outcome: "stale-namespace", namespaces: ["drop:a"] });
    expect((await coordinator.namespaceHeads()).find((head) => head.namespace === "drop:a")?.revisionId).toBe("nrev_a");
  });

  it("enforces append-only blinded path identities and keeps idempotency durable", async () => {
    const storage = new InMemoryCoordinatorStorage();
    const coordinator = new VaultCoordinatorCore(storage);
    const firstAppend = {
      protocolVersion: "1.1" as const,
      operationId: "op_append_1",
      vaultRevisionId: "rev_append_1",
      updates: [{ ...update("harness:codex:sandbox", "nrev_1"), mode: "append" as const }],
    };
    const firstResult = await coordinator.commitNamespaces(firstAppend);
    expect(firstResult).toMatchObject({ outcome: "committed" });
    expect(await new VaultCoordinatorCore(storage).commitNamespaces(firstAppend)).toEqual(firstResult);
    await expect(coordinator.commitNamespaces({
      protocolVersion: "1.1",
      operationId: "op_append_2",
      vaultRevisionId: "rev_append_2",
      updates: [{
        ...update("harness:codex:sandbox", "nrev_2", "nrev_1"),
        mode: "append",
        pathClaims: [{ pathId: "pth_nrev_1", mutation: "add" }],
      }],
    })).resolves.toEqual({ outcome: "append-violation", namespace: "harness:codex:sandbox", pathIds: ["pth_nrev_1"] });
    await expect(coordinator.commitNamespaces({ ...firstAppend, vaultRevisionId: "rev_other" }))
      .resolves.toEqual({ outcome: "idempotency-conflict" });
    expect(await coordinator.namespaceRevision("harness:codex:sandbox", "nrev_2")).toBeNull();
  });

  it("applies delete claims to the blinded live-path set", async () => {
    const coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
    await coordinator.commitNamespaces({ protocolVersion: "1.1", operationId: "op_add", vaultRevisionId: "rev_add", updates: [update("drop:a", "nrev_add")] });
    await expect(coordinator.commitNamespaces({
      protocolVersion: "1.1",
      operationId: "op_delete",
      vaultRevisionId: "rev_delete",
      updates: [{ ...update("drop:a", "nrev_delete", "nrev_add"), pathClaims: [{ pathId: "pth_nrev_add", mutation: "delete" }] }],
    })).resolves.toMatchObject({ outcome: "committed" });
    await expect(coordinator.commitNamespaces({
      protocolVersion: "1.1",
      operationId: "op_readd",
      vaultRevisionId: "rev_readd",
      updates: [{ ...update("drop:a", "nrev_readd", "nrev_delete"), mode: "append", pathClaims: [{ pathId: "pth_nrev_add", mutation: "add" }] }],
    })).resolves.toMatchObject({ outcome: "committed" });
  });
});

describe("three-way namespace merge (SY-002..SY-009)", () => {
  it("merges disjoint additions and preserves both writers", () => {
    const result = mergeNamespace(state(), state(entry("remote.txt", "remote")), state(entry("local.txt", "local")), { atomic: false });
    expect(result).toMatchObject({ outcome: "merged" });
    if (result.outcome !== "merged") return;
    expect(result.state.entries.map((item) => item.logicalPath)).toEqual(["local.txt", "remote.txt"]);
    expect(namespaceStateEquals(result.state, state(entry("local.txt", "local"), entry("remote.txt", "remote")))).toBe(true);
  });

  it("takes the only changed side and recognizes identical concurrent content", () => {
    const base = state(entry("file.txt", "base"));
    const remote = state(entry("file.txt", "remote"));
    const local = state(entry("file.txt", "local"));
    expect(mergeNamespace(base, remote, base, { atomic: false })).toMatchObject({ outcome: "merged", state: remote });
    expect(mergeNamespace(base, base, local, { atomic: false })).toMatchObject({ outcome: "merged", state: local });
    expect(mergeNamespace(base, remote, remote, { atomic: false })).toMatchObject({ outcome: "merged", state: remote });
  });

  it("reports same-path changes and modify/delete without choosing a winner", () => {
    const base = state(entry("file.txt", "base"));
    expect(mergeNamespace(base, state(entry("file.txt", "remote")), state(entry("file.txt", "local")), { atomic: false }))
      .toEqual({ outcome: "conflict", paths: ["file.txt"] });
    expect(mergeNamespace(base, state(entry("file.txt", "remote")), deleted("file.txt"), { atomic: false }))
      .toEqual({ outcome: "conflict", paths: ["file.txt"] });
  });

  it("treats a workspace transport namespace atomically", () => {
    const base = state(entry("capsule", "base"));
    expect(mergeNamespace(base, state(entry("capsule", "remote")), state(entry("blob", "local")), { atomic: true }))
      .toEqual({ outcome: "conflict", paths: ["blob", "capsule"] });
    expect(mergeNamespace(base, state(entry("capsule", "remote")), base, { atomic: true }))
      .toMatchObject({ outcome: "merged", state: state(entry("capsule", "remote")) });
  });

  it("rejects append-only overwrite, delete, and tombstone resurrection", () => {
    const base = { ...state(entry("kept.txt", "base"), entry("deleted.txt", "old")), tombstones: deleted("gone.txt").tombstones };
    const local = state(entry("kept.txt", "changed"), entry("new.txt", "new"), entry("gone.txt", "resurrected"));
    expect(appendOnlyViolations(base, local)).toEqual(["deleted.txt", "gone.txt", "kept.txt"]);
    expect(appendOnlyViolations(base, state(entry("kept.txt", "base"), entry("deleted.txt", "old"), entry("new.txt", "new")))).toEqual([]);
    expect(appendOnlyViolations(state(entry("kept.txt", "base")), deleted("kept.txt"))).toEqual(["kept.txt"]);
  });

  it("fails closed when a decrypted namespace state repeats a logical path", () => {
    expect(() => namespaceStateEquals(state(entry("same.txt", "one"), entry("same.txt", "two")), state())).toThrow("duplicate namespace path");
    expect(() => namespaceStateEquals({
      entries: [entry("same.txt", "one")],
      tombstones: [{ namespace, logicalPath: "same.txt", deletedAt: "2026-09-06T00:00:00.000Z" }],
    }, state())).toThrow("duplicate namespace path");
  });

  it("converges deterministically for randomized disjoint offline additions", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.integer({ min: 0, max: 100 }), { maxLength: 30 }),
      fc.uniqueArray(fc.integer({ min: 0, max: 100 }), { maxLength: 30 }),
      (remoteValues, localValues) => {
        const remote = state(...remoteValues.map((value) => entry(`remote/${value}`, `r${value}`)));
        const local = state(...localValues.map((value) => entry(`local/${value}`, `l${value}`)));
        const forward = mergeNamespace(state(), remote, local, { atomic: false });
        const reverse = mergeNamespace(state(), local, remote, { atomic: false });
        expect(forward.outcome).toBe("merged");
        expect(reverse.outcome).toBe("merged");
        if (forward.outcome === "merged" && reverse.outcome === "merged") {
          expect(namespaceStateEquals(forward.state, reverse.state)).toBe(true);
        }
      },
    ), { numRuns: 250 });
  });
});

const namespace = "drop:shared";

function entry(logicalPath: string, digest: string) {
  return { namespace, logicalPath, entryType: "file" as const, objectIds: [`obj_${digest}`], totalSize: 1, contentDigest: `digest_${digest}` };
}

function state(...entries: ReturnType<typeof entry>[]) {
  return { entries, tombstones: [] as Array<{ namespace: string; logicalPath: string; deletedAt: string }> };
}

function deleted(logicalPath: string) {
  return { entries: [] as ReturnType<typeof entry>[], tombstones: [{ namespace, logicalPath, deletedAt: "2026-09-06T00:00:00.000Z" }] };
}
