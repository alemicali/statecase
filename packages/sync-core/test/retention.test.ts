import { describe, expect, it } from "vitest";

import { InMemoryCoordinatorStorage, VaultCoordinatorCore } from "../src/index.js";
import { DEFAULT_RETENTION_POLICY, selectRetentionCheckpoints } from "../src/retention.js";

describe("deterministic retention checkpoints (BK-002)", () => {
  it("selects the newest chain revision in UTC hourly, daily, and monthly buckets", () => {
    const now = Date.parse("2024-03-01T00:30:00.000Z");
    const revisions = Array.from({ length: 400 }, (_, index) => ({
      revisionId: `srev_${String(index).padStart(3, "0")}`,
      committedAt: now - index * 60 * 60 * 1000,
    }));

    const selected = selectRetentionCheckpoints(revisions, now);

    expect(selected.filter((item) => item.tier === "hourly")).toHaveLength(24);
    expect(selected.filter((item) => item.tier === "daily").map((item) => item.bucket).slice(0, 3))
      .toEqual(["2024-03-01", "2024-02-29", "2024-02-28"]);
    expect(selected.filter((item) => item.tier === "monthly").map((item) => item.bucket))
      .toEqual(["2024-03", "2024-02"]);
    expect(selected.find((item) => item.tier === "hourly" && item.bucket === "2024-02-29T23")?.revisionId)
      .toBe("srev_001");
  });

  it("is independent of timezone offsets and conservative under forward/backward clock skew", () => {
    const now = Date.parse("2026-10-25T01:30:00.000Z");
    const selected = selectRetentionCheckpoints([
      { revisionId: "srev_chain_head", committedAt: Date.parse("2026-10-25T03:30:00+02:00") },
      { revisionId: "srev_clock_forward", committedAt: Date.parse("2026-11-01T00:00:00Z") },
      { revisionId: "srev_clock_back", committedAt: Date.parse("2026-10-25T01:15:00Z") },
      { revisionId: "srev_previous_hour", committedAt: Date.parse("2026-10-25T02:45:00+02:00") },
    ], now);

    expect(selected.find((item) => item.tier === "hourly" && item.bucket === "2026-10-25T01")?.revisionId)
      .toBe("srev_chain_head");
    expect(selected.find((item) => item.tier === "hourly" && item.bucket === "2026-10-25T00")?.revisionId)
      .toBe("srev_previous_hour");
    expect(new Set(selected.map((item) => `${item.tier}:${item.bucket}`)).size).toBe(selected.length);
  });

  it("honors zero/custom tiers and rejects ambiguous or invalid input", () => {
    const revisions = [{ revisionId: "srev_01", committedAt: 1_000 }];
    expect(selectRetentionCheckpoints(revisions, 1_000, { hourly: 0, daily: 0, monthly: 0 })).toEqual([]);
    expect(selectRetentionCheckpoints(revisions, 1_000, { ...DEFAULT_RETENTION_POLICY, hourly: 1, daily: 0, monthly: 0 }))
      .toEqual([{ tier: "hourly", bucket: "1970-01-01T00", revisionId: "srev_01", committedAt: 1_000 }]);
    expect(() => selectRetentionCheckpoints([...revisions, ...revisions], 1_000)).toThrow("duplicate revision ID");
    expect(() => selectRetentionCheckpoints([{ revisionId: "", committedAt: 1_000 }], 1_000)).toThrow("revision ID");
    expect(() => selectRetentionCheckpoints([{ revisionId: "srev_01", committedAt: Number.NaN }], 1_000)).toThrow("timestamp");
    expect(() => selectRetentionCheckpoints(revisions, -1)).toThrow("current time");
    expect(() => selectRetentionCheckpoints(revisions, 1_000, { hourly: -1, daily: 1, monthly: 1 })).toThrow("retention count");
  });
});

describe("encrypted-object reachability and garbage-collection lease (BK-003..BK-005)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-09-07T12:00:00.000Z");
  const old = now - 60 * DAY;
  const candidate = (namespace: string | null, objectId: string, uploadedAt = old) => ({ namespace, objectId, uploadedAt, size: 10 });
  const update = (
    namespace: string,
    revisionId: string,
    baseNamespaceRevisionId: string | null,
    retainedVaultRevisionIds: string[] = [],
    mode: "replace" | "append" = "replace",
  ) => ({
    namespace,
    baseNamespaceRevisionId,
    namespaceRevisionId: revisionId,
    manifestObjectId: `obj_manifest_${revisionId}`,
    requiredObjectIds: [`obj_chunk_${revisionId}`],
    retainedVaultRevisionIds,
    mode,
    pathClaims: [{ pathId: `pth_${revisionId}`, mutation: "add" as const }],
  });
  const commit = (
    coordinator: VaultCoordinatorCore,
    vaultRevisionId: string,
    updates: ReturnType<typeof update>[],
    committedAt: number,
  ) => coordinator.commitNamespaces({ protocolVersion: "1.1", operationId: `op_${vaultRevisionId}`, vaultRevisionId, updates }, committedAt);

  it("preserves head, protected snapshot, capsule pins, conflicts, pending/grace objects and collects only unreachable data", async () => {
    const coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
    await commit(coordinator, "srev_old", [update("workspace:ws", "nrev_old", null)], old);
    await commit(coordinator, "srev_mid", [update("workspace:ws", "nrev_mid", "nrev_old")], old + DAY);
    const protectedMid = await coordinator.createSnapshot({ id: "snp_mid", name: "mid", createdAt: old + DAY });
    expect(protectedMid).toMatchObject({ outcome: "created" });
    await commit(coordinator, "srev_harness", [update("harness:codex:default", "nrev_harness", null, ["srev_old"])], old + 2 * DAY);
    await commit(coordinator, "srev_current", [update("workspace:ws", "nrev_current", "nrev_mid")], old + 3 * DAY);

    const allCandidates = [
      ...["nrev_old", "nrev_mid", "nrev_current"].flatMap((revisionId) => [
        candidate("workspace:ws", `obj_manifest_${revisionId}`),
        candidate("workspace:ws", `obj_chunk_${revisionId}`),
      ]),
      candidate("harness:codex:default", "obj_manifest_nrev_harness"),
      candidate("harness:codex:default", "obj_chunk_nrev_harness"),
      candidate("workspace:ws", "obj_orphan"),
      candidate("workspace:ws", "obj_pending_upload", now - DAY),
      candidate("workspace:ws", "obj_before_tracking", old - 1),
      candidate(null, "obj_legacy_orphan"),
    ];

    const protectedPlan = await coordinator.planGarbageCollection({
      id: "gc_protected",
      now,
      gracePeriodMs: 30 * DAY,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: allCandidates,
      dryRun: true,
    });
    expect(protectedPlan.outcome).toBe("planned");
    if (protectedPlan.outcome !== "planned") return;
    expect(protectedPlan.plan.deleteObjects).toEqual([candidate("workspace:ws", "obj_orphan")]);
    expect(protectedPlan.plan.reachableVaultRevisionIds).toEqual(expect.arrayContaining(["srev_current", "srev_old", "srev_mid"]));
    expect(protectedPlan.plan.conservativeScopes).toContain("legacy");

    await coordinator.deleteSnapshot("snp_mid");
    const unprotectedPlan = await coordinator.planGarbageCollection({
      id: "gc_unprotected",
      now,
      gracePeriodMs: 30 * DAY,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: allCandidates,
      dryRun: true,
    });
    expect(unprotectedPlan.outcome).toBe("planned");
    if (unprotectedPlan.outcome !== "planned") return;
    expect(unprotectedPlan.plan.deleteObjects.map((item) => item.objectId).sort())
      .toEqual(["obj_chunk_nrev_mid", "obj_manifest_nrev_mid", "obj_orphan"]);
    expect(unprotectedPlan.plan.deleteObjects.map((item) => item.objectId)).not.toContain("obj_pending_upload");
    expect(unprotectedPlan.plan.deleteObjects.map((item) => item.objectId)).not.toContain("obj_before_tracking");

    const executablePlan = await coordinator.planGarbageCollection({
      id: "gc_finalize",
      now,
      gracePeriodMs: 30 * DAY,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: allCandidates,
      dryRun: false,
    });
    expect(executablePlan.outcome).toBe("planned");
    expect(await coordinator.finalizeGarbageCollection("gc_finalize")).toBe(true);
    expect(await coordinator.scopedRevision("srev_mid")).toBeNull();
    expect(await coordinator.namespaceRevision("workspace:ws", "nrev_mid")).toBeNull();
    expect(await coordinator.scopedRevision("srev_current")).not.toBeNull();
    expect(await coordinator.scopedRevision("srev_old")).not.toBeNull();
    expect(await coordinator.namespaceRevision("workspace:ws", "nrev_old")).not.toBeNull();
  });

  it("blocks commits behind a GC lease, keeps snapshot creation safe, and requires collector takeover after expiry (BK-014)", async () => {
    const coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
    await commit(coordinator, "srev_01", [update("drop:docs", "nrev_01", null)], old);
    const started = await coordinator.planGarbageCollection({
      id: "gc_live",
      now,
      gracePeriodMs: 30 * DAY,
      leaseMs: 60_000,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: [candidate("drop:docs", "obj_orphan")],
      dryRun: false,
    });
    expect(started).toMatchObject({ outcome: "planned", plan: { id: "gc_live" } });
    await expect(commit(coordinator, "srev_blocked", [update("drop:docs", "nrev_blocked", "nrev_01")], now + 1))
      .resolves.toEqual({ outcome: "gc-busy", retryAfterMs: 59_999 });
    await expect(coordinator.createSnapshot({ id: "snp_during_gc", name: "safe", createdAt: now + 1 }))
      .resolves.toMatchObject({ outcome: "created", snapshot: { revisionId: "srev_01" } });
    await expect(coordinator.planGarbageCollection({
      id: "gc_other",
      now: now + 1,
      gracePeriodMs: 30 * DAY,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: [],
      dryRun: false,
    })).resolves.toEqual({ outcome: "busy", planId: "gc_live", retryAfterMs: 59_999 });

    expect(await coordinator.finalizeGarbageCollection("gc_wrong")).toBe(false);
    expect(await coordinator.finalizeGarbageCollection("gc_live")).toBe(true);
    await expect(commit(coordinator, "srev_after", [update("drop:docs", "nrev_after", "nrev_01")], now + 2))
      .resolves.toMatchObject({ outcome: "committed" });

    await coordinator.planGarbageCollection({
      id: "gc_expiring",
      now: now + 3,
      gracePeriodMs: 30 * DAY,
      leaseMs: 1,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: [],
      dryRun: false,
    });
    await expect(commit(coordinator, "srev_expired", [update("drop:docs", "nrev_expired", "nrev_after")], now + 5))
      .resolves.toEqual({ outcome: "gc-busy", retryAfterMs: 1_000 });
    await expect(coordinator.planGarbageCollection({
      id: "gc_takeover",
      now: now + 5,
      gracePeriodMs: 30 * DAY,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: [],
      dryRun: false,
    })).resolves.toMatchObject({ outcome: "planned", plan: { id: "gc_takeover" } });
    expect(await coordinator.finalizeGarbageCollection("gc_takeover")).toBe(true);
    await expect(commit(coordinator, "srev_recovered", [update("drop:docs", "nrev_recovered", "nrev_after")], now + 6))
      .resolves.toMatchObject({ outcome: "committed" });
  });

  it("walks append delta parents and validates the complete candidate inventory before planning", async () => {
    const coordinator = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
    await commit(coordinator, "srev_snapshot", [update("harness:claude:default", "nrev_snapshot", null)], old);
    await commit(coordinator, "srev_delta", [update("harness:claude:default", "nrev_delta", "nrev_snapshot", [], "append")], old + DAY);
    const candidates = [
      candidate("harness:claude:default", "obj_manifest_nrev_snapshot"),
      candidate("harness:claude:default", "obj_chunk_nrev_snapshot"),
      candidate("harness:claude:default", "obj_manifest_nrev_delta"),
      candidate("harness:claude:default", "obj_chunk_nrev_delta"),
    ];
    const planned = await coordinator.planGarbageCollection({
      id: "gc_delta",
      now,
      gracePeriodMs: 30 * DAY,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates,
      dryRun: true,
    });
    expect(planned).toMatchObject({ outcome: "planned", plan: { deleteObjects: [] } });
    if (planned.outcome !== "planned") return;
    expect(planned.plan.reachableNamespaceRevisionIds).toEqual([
      { namespace: "harness:claude:default", revisionId: "nrev_delta" },
      { namespace: "harness:claude:default", revisionId: "nrev_snapshot" },
    ]);
    await expect(coordinator.planGarbageCollection({
      id: "gc_duplicate_candidates",
      now,
      gracePeriodMs: 0,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: [candidates[0]!, candidates[0]!],
      dryRun: true,
    })).rejects.toThrow("duplicate garbage-collection candidate");
    await expect(coordinator.planGarbageCollection({
      id: "gc_invalid_candidate",
      now,
      gracePeriodMs: 0,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: [{ ...candidates[0]!, uploadedAt: Number.NaN }],
      dryRun: true,
    })).rejects.toThrow("upload time");
    await expect(coordinator.planGarbageCollection({
      id: "gc_invalid_candidate_namespace",
      now,
      gracePeriodMs: 0,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: [{ ...candidates[0]!, namespace: "drop/invalid" }],
      dryRun: true,
    })).rejects.toThrow("namespace");
    await expect(coordinator.planGarbageCollection({
      id: "gc_invalid_candidate_object",
      now,
      gracePeriodMs: 0,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: [{ ...candidates[0]!, objectId: "obj/invalid" }],
      dryRun: true,
    })).rejects.toThrow("object ID");
    await expect(coordinator.planGarbageCollection({
      id: "gc_unsafe_delete_size",
      now,
      gracePeriodMs: 0,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: [
        { ...candidate("harness:claude:default", "obj_orphan_1"), size: Number.MAX_SAFE_INTEGER },
        candidate("harness:claude:default", "obj_orphan_2"),
      ],
      dryRun: true,
    })).rejects.toThrow("total size");
    await expect(coordinator.planGarbageCollection({
      id: "gc_oversized_inventory",
      now,
      gracePeriodMs: 0,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: Array.from({ length: 100_001 }, (_, index) => candidate("harness:claude:default", `obj_${index}`)),
      dryRun: true,
    })).rejects.toThrow("candidate limit");
  });

  it("fails conservative for pre-metadata namespace history and rejects revision-ID replacement (BK-013)", async () => {
    const storage = new InMemoryCoordinatorStorage();
    await storage.putMany({
      "scoped:head": { revisionId: "srev_legacy_scoped" },
      "scoped:namespaces": ["drop:old"],
      "scoped:namespace:drop:old:head": { namespace: "drop:old", revisionId: "nrev_old", manifestObjectId: "obj_old_manifest" },
      "scoped:namespace:drop:old:revision:nrev_old": { namespace: "drop:old", revisionId: "nrev_old", manifestObjectId: "obj_old_manifest", previousRevisionId: null },
      "scoped:revision:srev_legacy_scoped": {
        revisionId: "srev_legacy_scoped",
        previousRevisionId: null,
        namespaces: [{ namespace: "drop:old", revisionId: "nrev_old", manifestObjectId: "obj_old_manifest" }],
      },
    });
    const coordinator = new VaultCoordinatorCore(storage);
    const plan = await coordinator.planGarbageCollection({
      id: "gc_legacy",
      now,
      gracePeriodMs: 30 * DAY,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: [candidate("drop:old", "obj_old_manifest", old - DAY), candidate("drop:old", "obj_unknown", old - DAY)],
      dryRun: true,
    });
    expect(plan).toMatchObject({ outcome: "planned", plan: { deleteObjects: [], conservativeScopes: ["drop:old", "legacy"] } });

    const fresh = new VaultCoordinatorCore(new InMemoryCoordinatorStorage());
    await commit(fresh, "srev_same", [update("drop:new", "nrev_same", null)], old);
    await expect(fresh.commitNamespaces({
      protocolVersion: "1.1",
      operationId: "op_reuse",
      vaultRevisionId: "srev_same",
      updates: [update("drop:new", "nrev_other", "nrev_same")],
    }, old + 1)).resolves.toEqual({ outcome: "revision-conflict" });
    await expect(fresh.commitNamespaces({
      protocolVersion: "1.1",
      operationId: "op_namespace_reuse",
      vaultRevisionId: "srev_other",
      updates: [update("drop:new", "nrev_same", "nrev_same")],
    }, old + 1)).resolves.toEqual({ outcome: "revision-conflict" });
  });

  it("fails without a deletion plan when coordinator reachability metadata exceeds its bound (BK-013)", async () => {
    const storage = new InMemoryCoordinatorStorage();
    await storage.putMany(Object.fromEntries(Array.from({ length: 100_001 }, (_, index) => [
      `retention:scoped:revision:srev_${index}`,
      0,
    ])));
    const coordinator = new VaultCoordinatorCore(storage);
    await expect(coordinator.planGarbageCollection({
      id: "gc_oversized_graph",
      now,
      gracePeriodMs: 0,
      policy: { hourly: 0, daily: 0, monthly: 0 },
      candidates: [],
      dryRun: true,
    })).rejects.toThrow("listing exceeds the safety limit");
  });
});
