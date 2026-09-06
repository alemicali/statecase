import { describe, expect, it } from "vitest";

import { InMemoryCoordinatorStorage, VaultCoordinatorCore } from "../src/index.js";

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
