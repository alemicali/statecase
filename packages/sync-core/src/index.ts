import {
  canonicalJson,
  commitRequestSchema,
  scopedCommitRequestSchema,
  type CommitRequest,
  type ScopedCommitRequest,
  type VaultManifestV1,
} from "@statecase/protocol";
import { selectRetentionCheckpoints, type RetentionCheckpoint, type RetentionPolicy, type RetentionRevision } from "./retention.js";

export {
  DEFAULT_RETENTION_POLICY,
  selectRetentionCheckpoints,
  type RetentionCheckpoint,
  type RetentionPolicy,
  type RetentionRevision,
  type RetentionTier,
} from "./retention.js";

type ManifestEntry = VaultManifestV1["entries"][number];
type ManifestTombstone = VaultManifestV1["tombstones"][number];

export interface NamespaceState {
  entries: ManifestEntry[];
  tombstones: ManifestTombstone[];
}

export type NamespaceMergeResult =
  | { outcome: "merged"; state: NamespaceState }
  | { outcome: "conflict"; paths: string[] };

type PathState = { kind: "entry"; value: ManifestEntry } | { kind: "tombstone"; value: ManifestTombstone };

/** Deterministic content-addressed three-way merge; it never chooses a winner for concurrent same-path edits. */
export function mergeNamespace(
  base: NamespaceState,
  remote: NamespaceState,
  local: NamespaceState,
  options: { atomic: boolean },
): NamespaceMergeResult {
  if (options.atomic) {
    if (namespaceStateEquals(local, base)) return { outcome: "merged", state: normalizedState(remote) };
    if (namespaceStateEquals(remote, base)) return { outcome: "merged", state: normalizedState(local) };
    if (namespaceStateEquals(local, remote)) return { outcome: "merged", state: normalizedState(remote) };
    return { outcome: "conflict", paths: allPaths(base, remote, local) };
  }

  const basePaths = pathStates(base);
  const remotePaths = pathStates(remote);
  const localPaths = pathStates(local);
  const entries: ManifestEntry[] = [];
  const tombstones: ManifestTombstone[] = [];
  const conflicts: string[] = [];
  for (const path of allPaths(base, remote, local)) {
    const baseState = basePaths.get(path);
    const remoteState = remotePaths.get(path);
    const localState = localPaths.get(path);
    let selected: PathState | undefined;
    if (pathStateEquals(localState, baseState)) selected = remoteState;
    else if (pathStateEquals(remoteState, baseState)) selected = localState;
    else if (pathStateEquals(localState, remoteState)) selected = remoteState;
    else {
      conflicts.push(path);
      continue;
    }
    if (selected?.kind === "entry") entries.push(selected.value);
    if (selected?.kind === "tombstone") tombstones.push(selected.value);
  }
  if (conflicts.length > 0) return { outcome: "conflict", paths: conflicts };
  return { outcome: "merged", state: normalizedState({ entries, tombstones }) };
}

export function namespaceStateEquals(left: NamespaceState, right: NamespaceState): boolean {
  const leftPaths = pathStates(left);
  const rightPaths = pathStates(right);
  const paths = new Set([...leftPaths.keys(), ...rightPaths.keys()]);
  return [...paths].every((path) => pathStateEquals(leftPaths.get(path), rightPaths.get(path)));
}

/** Returns paths where an append-only writer would mutate or erase prior state. */
export function appendOnlyViolations(base: NamespaceState, local: NamespaceState): string[] {
  const basePaths = pathStates(base);
  const localPaths = pathStates(local);
  const violations: string[] = [];
  for (const path of new Set([...basePaths.keys(), ...localPaths.keys()])) {
    const before = basePaths.get(path);
    const after = localPaths.get(path);
    if (!before) {
      if (after?.kind === "tombstone") violations.push(path);
      continue;
    }
    if (before.kind === "tombstone") {
      if (after?.kind === "entry") violations.push(path);
      continue;
    }
    if (!after || after.kind !== "entry" || !pathStateEquals(before, after)) violations.push(path);
  }
  return violations.sort((left, right) => left.localeCompare(right, "en"));
}

function pathStates(state: NamespaceState): Map<string, PathState> {
  const paths = new Map<string, PathState>();
  for (const entry of state.entries) {
    if (paths.has(entry.logicalPath)) throw new Error(`duplicate namespace path: ${entry.logicalPath}`);
    paths.set(entry.logicalPath, { kind: "entry", value: entry });
  }
  for (const tombstone of state.tombstones) {
    if (paths.has(tombstone.logicalPath)) throw new Error(`duplicate namespace path: ${tombstone.logicalPath}`);
    paths.set(tombstone.logicalPath, { kind: "tombstone", value: tombstone });
  }
  return paths;
}

function pathStateEquals(left: PathState | undefined, right: PathState | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "tombstone") return true;
  return semanticEntry(left.value) === semanticEntry((right as Extract<PathState, { kind: "entry" }>).value);
}

// Callers normalize keyed content digests into one epoch before comparing.
// Encryption and chunk boundaries describe storage, not a user's file edit.
function semanticEntry(entry: ManifestEntry): string {
  const { objectIds: _objects, chunking: _chunking, keyEpoch: _epoch, ...semantic } = entry;
  return canonicalJson(semantic);
}

function allPaths(...states: NamespaceState[]): string[] {
  return [...new Set(states.flatMap((state) => [...state.entries, ...state.tombstones].map((item) => item.logicalPath)))]
    .sort((left, right) => left.localeCompare(right, "en"));
}

function normalizedState(state: NamespaceState): NamespaceState {
  return {
    entries: [...state.entries].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, "en")),
    tombstones: [...state.tombstones].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, "en")),
  };
}

export interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(prefix: string, limit: number): Promise<Map<string, T>>;
  putMany(entries: Readonly<Record<string, unknown>>): Promise<void>;
  deleteMany(keys: readonly string[]): Promise<void>;
}

export interface VaultHead {
  revisionId: string;
  manifestObjectId: string;
}

export interface VaultRevision extends VaultHead {
  previousRevisionId: string | null;
}

export interface VaultSnapshot {
  id: string;
  name: string;
  revisionId: string;
  manifestObjectId?: string;
  protocolVersion?: "1.1";
  protected: true;
  createdAt: number;
}

export type CreateSnapshotResult =
  | { outcome: "created"; snapshot: VaultSnapshot }
  | { outcome: "no-head" }
  | { outcome: "id-conflict" };

export type CommitResult =
  | { outcome: "committed"; revisionId: string; previousRevisionId: string | null }
  | { outcome: "idempotency-conflict" }
  | { outcome: "revision-conflict" }
  | { outcome: "gc-busy"; retryAfterMs: number }
  | { outcome: "stale-base"; currentRevisionId: string | null };

interface StoredOperation {
  fingerprint: string;
  result: Extract<CommitResult, { outcome: "committed" }>;
}

export interface NamespaceHead {
  namespace: string;
  revisionId: string;
  manifestObjectId: string;
  /** Server-authorized mode; absent only on revisions predating provenance. */
  commitMode?: "replace" | "append";
  keyEpoch?: number;
}

export interface NamespaceRevision extends NamespaceHead {
  previousRevisionId: string | null;
}

export interface ScopedVaultHead {
  revisionId: string;
}

export interface ScopedVaultRevision extends ScopedVaultHead {
  previousRevisionId: string | null;
  namespaces: NamespaceHead[];
}

export type ScopedCommitResult =
  | { outcome: "committed"; revisionId: string; previousRevisionId: string | null }
  | { outcome: "idempotency-conflict" }
  | { outcome: "revision-conflict" }
  | { outcome: "gc-busy"; retryAfterMs: number }
  | { outcome: "stale-namespace"; namespaces: string[] }
  | { outcome: "append-violation"; namespace: string; pathIds: string[] };

interface StoredScopedOperation {
  fingerprint: string;
  result: Extract<ScopedCommitResult, { outcome: "committed" }>;
}

const HEAD_KEY = "head";
const SNAPSHOTS_KEY = "snapshots";
const SCOPED_HEAD_KEY = "scoped:head";
const NAMESPACE_NAMES_KEY = "scoped:namespaces";
const RETENTION_TRACKED_SINCE_KEY = "retention:tracked-since";
const RETENTION_CHECKPOINTS_KEY = "retention:checkpoints";
const ACTIVE_GC_KEY = "retention:gc:active";
const MAX_SNAPSHOTS = 1_000;
const MAX_RETENTION_GRAPH = 100_000;
const DEFAULT_GC_LEASE_MS = 5 * 60_000;
const RETENTION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

interface ScopedRetentionMetadata extends RetentionRevision {
  previousRevisionId: string | null;
  operationId: string;
  sequence: number;
}

interface NamespaceRetentionMetadata {
  namespace: string;
  revisionId: string;
  previousRevisionId: string | null;
  mode: "snapshot" | "delta";
  objectIds: string[];
  retainedVaultRevisionIds: string[];
  committedAt: number;
  operationId: string;
}

interface ActiveGarbageCollection {
  id: string;
  expiresAt: number;
  checkpoints: RetentionCheckpoint[];
  rootVaultRevisionIds: string[];
}

interface RetentionGraph {
  reachableVaultRevisionIds: Set<string>;
  reachableNamespaceRevisionIds: Set<string>;
  reachableObjects: Set<string>;
  conservativeScopes: Set<string>;
  globalConservative: boolean;
}

export interface GarbageObjectCandidate {
  namespace: string | null;
  objectId: string;
  uploadedAt: number;
  size: number;
}

export interface GarbageCollectionPlan {
  id: string;
  createdAt: number;
  expiresAt: number | null;
  gracePeriodMs: number;
  trackedSince: number | null;
  checkpoints: RetentionCheckpoint[];
  reachableVaultRevisionIds: string[];
  reachableNamespaceRevisionIds: Array<{ namespace: string; revisionId: string }>;
  reachableObjects: Array<{ namespace: string; objectId: string }>;
  deleteObjects: GarbageObjectCandidate[];
  deleteBytes: number;
  conservativeScopes: string[];
}

export type GarbageCollectionPlanResult =
  | { outcome: "planned"; plan: GarbageCollectionPlan }
  | { outcome: "busy"; planId: string; retryAfterMs: number };

export class VaultCoordinatorCore {
  readonly #storage: CoordinatorStorage;

  constructor(storage: CoordinatorStorage) {
    this.#storage = storage;
  }

  async head(): Promise<VaultHead | null> {
    return (await this.#storage.get<VaultHead>(HEAD_KEY)) ?? null;
  }

  async revision(revisionId: string): Promise<VaultRevision | null> {
    return (await this.#storage.get<VaultRevision>(`revision:${revisionId}`)) ?? null;
  }

  async namespaceHeads(allowedNamespaces?: ReadonlySet<string>): Promise<NamespaceHead[]> {
    const names = (await this.#storage.get<string[]>(NAMESPACE_NAMES_KEY)) ?? [];
    const selected = allowedNamespaces ? names.filter((namespace) => allowedNamespaces.has(namespace)) : names;
    const heads = await Promise.all(selected.map((namespace) => this.#storage.get<NamespaceHead>(namespaceHeadKey(namespace))));
    return heads.filter((head): head is NamespaceHead => head !== undefined)
      .sort((left, right) => left.namespace.localeCompare(right.namespace, "en"));
  }

  async namespaceRevision(namespace: string, revisionId: string): Promise<NamespaceRevision | null> {
    return (await this.#storage.get<NamespaceRevision>(namespaceRevisionKey(namespace, revisionId))) ?? null;
  }

  async scopedHead(): Promise<ScopedVaultHead | null> {
    return (await this.#storage.get<ScopedVaultHead>(SCOPED_HEAD_KEY)) ?? null;
  }

  async scopedRevision(revisionId: string): Promise<ScopedVaultRevision | null> {
    return (await this.#storage.get<ScopedVaultRevision>(`scoped:revision:${revisionId}`)) ?? null;
  }

  async listSnapshots(): Promise<VaultSnapshot[]> {
    return (await this.#storage.get<VaultSnapshot[]>(SNAPSHOTS_KEY)) ?? [];
  }

  async createSnapshot(input: { id: string; name: string; createdAt: number }): Promise<CreateSnapshotResult> {
    const snapshots = await this.listSnapshots();
    const existing = snapshots.find((snapshot) => snapshot.id === input.id);
    if (existing) {
      return existing.name === input.name
        ? { outcome: "created", snapshot: existing }
        : { outcome: "id-conflict" };
    }
    const scopedHead = await this.scopedHead();
    const legacyHead = scopedHead ? null : await this.head();
    if (!scopedHead && !legacyHead) return { outcome: "no-head" };
    if (snapshots.length >= MAX_SNAPSHOTS) throw new Error("snapshot limit reached");
    const snapshot: VaultSnapshot = scopedHead
      ? { id: input.id, name: input.name, revisionId: scopedHead.revisionId, protocolVersion: "1.1", protected: true, createdAt: input.createdAt }
      : { id: input.id, name: input.name, ...legacyHead!, protected: true, createdAt: input.createdAt };
    await this.#storage.putMany({ [SNAPSHOTS_KEY]: [...snapshots, snapshot] });
    return { outcome: "created", snapshot };
  }

  async deleteSnapshot(snapshotId: string): Promise<boolean> {
    const snapshots = await this.listSnapshots();
    if (!snapshots.some((snapshot) => snapshot.id === snapshotId)) return false;
    await this.#storage.putMany({ [SNAPSHOTS_KEY]: snapshots.filter((snapshot) => snapshot.id !== snapshotId) });
    return true;
  }

  async commit(unknownRequest: CommitRequest, committedAt = Date.now()): Promise<CommitResult> {
    const request = commitRequestSchema.parse(unknownRequest);
    assertTimestamp(committedAt, "commit time");
    const fingerprint = await requestFingerprint(request);
    const operationKey = `operation:${request.operationId}`;
    const existing = await this.#storage.get<StoredOperation>(operationKey);
    if (existing) {
      return existing.fingerprint === fingerprint ? existing.result : { outcome: "idempotency-conflict" };
    }

    const activeGc = await this.#activeGarbageCollection();
    if (activeGc) return { outcome: "gc-busy", retryAfterMs: Math.max(1_000, activeGc.expiresAt - committedAt) };
    if (await this.revision(request.revisionId)) return { outcome: "revision-conflict" };

    const currentHead = await this.head();
    const currentRevisionId = currentHead?.revisionId ?? null;
    if (request.baseRevisionId !== currentRevisionId) {
      return { outcome: "stale-base", currentRevisionId };
    }
    const result = {
      outcome: "committed" as const,
      revisionId: request.revisionId,
      previousRevisionId: currentRevisionId,
    };
    await this.#storage.putMany({
      [HEAD_KEY]: { revisionId: request.revisionId, manifestObjectId: request.manifestObjectId } satisfies VaultHead,
      [`revision:${request.revisionId}`]: {
        revisionId: request.revisionId,
        manifestObjectId: request.manifestObjectId,
        previousRevisionId: currentRevisionId,
      } satisfies VaultRevision,
      [operationKey]: { fingerprint, result } satisfies StoredOperation,
    });
    return result;
  }

  /** Atomically advances only the namespaces named by a scoped commit. */
  async commitNamespaces(unknownRequest: ScopedCommitRequest, committedAt = Date.now()): Promise<ScopedCommitResult> {
    const request = scopedCommitRequestSchema.parse(unknownRequest);
    assertTimestamp(committedAt, "commit time");
    const fingerprint = await requestFingerprint(request);
    const operationKey = `scoped:operation:${request.operationId}`;
    const existing = await this.#storage.get<StoredScopedOperation>(operationKey);
    if (existing) return existing.fingerprint === fingerprint ? existing.result : { outcome: "idempotency-conflict" };

    const activeGc = await this.#activeGarbageCollection();
    if (activeGc) return { outcome: "gc-busy", retryAfterMs: Math.max(1_000, activeGc.expiresAt - committedAt) };
    if (await this.scopedRevision(request.vaultRevisionId)) return { outcome: "revision-conflict" };
    for (const update of request.updates) {
      if (await this.namespaceRevision(update.namespace, update.namespaceRevisionId)) return { outcome: "revision-conflict" };
    }

    const currentHeads = new Map<string, NamespaceHead | undefined>();
    for (const update of request.updates) {
      currentHeads.set(update.namespace, await this.#storage.get<NamespaceHead>(namespaceHeadKey(update.namespace)));
    }
    const stale = request.updates
      .filter((update) => (currentHeads.get(update.namespace)?.revisionId ?? null) !== update.baseNamespaceRevisionId)
      .map((update) => update.namespace)
      .sort((left, right) => left.localeCompare(right, "en"));
    if (stale.length > 0) return { outcome: "stale-namespace", namespaces: stale };

    const nextPaths = new Map<string, Set<string>>();
    for (const update of request.updates) {
      const paths = new Set((await this.#storage.get<string[]>(namespacePathsKey(update.namespace))) ?? []);
      if (update.mode === "append") {
        const violations = update.pathClaims.filter((claim) => paths.has(claim.pathId)).map((claim) => claim.pathId)
          .sort((left, right) => left.localeCompare(right, "en"));
        if (violations.length > 0) return { outcome: "append-violation", namespace: update.namespace, pathIds: violations };
      }
      for (const claim of update.pathClaims) {
        if (claim.mutation === "delete") paths.delete(claim.pathId);
        else paths.add(claim.pathId);
      }
      nextPaths.set(update.namespace, paths);
    }

    const previousRevisionId = (await this.scopedHead())?.revisionId ?? null;
    const previousRetention = previousRevisionId
      ? await this.#storage.get<ScopedRetentionMetadata>(scopedRetentionKey(previousRevisionId))
      : undefined;
    const effectiveCommittedAt = Math.max(committedAt, previousRetention?.committedAt ?? 0);
    const result = { outcome: "committed" as const, revisionId: request.vaultRevisionId, previousRevisionId };
    const names = new Set((await this.#storage.get<string[]>(NAMESPACE_NAMES_KEY)) ?? []);
    const writes: Record<string, unknown> = {
      [SCOPED_HEAD_KEY]: { revisionId: request.vaultRevisionId } satisfies ScopedVaultHead,
      [operationKey]: { fingerprint, result } satisfies StoredScopedOperation,
      [scopedRetentionKey(request.vaultRevisionId)]: {
        revisionId: request.vaultRevisionId,
        previousRevisionId,
        committedAt: effectiveCommittedAt,
        operationId: request.operationId,
        sequence: (previousRetention?.sequence ?? 0) + 1,
      } satisfies ScopedRetentionMetadata,
    };
    for (const update of request.updates) {
      names.add(update.namespace);
      writes[namespaceHeadKey(update.namespace)] = {
        namespace: update.namespace,
        revisionId: update.namespaceRevisionId,
        manifestObjectId: update.manifestObjectId,
        commitMode: update.mode,
        ...(update.keyEpoch === undefined ? {} : { keyEpoch: update.keyEpoch }),
      } satisfies NamespaceHead;
      writes[namespaceRevisionKey(update.namespace, update.namespaceRevisionId)] = {
        namespace: update.namespace,
        revisionId: update.namespaceRevisionId,
        manifestObjectId: update.manifestObjectId,
        commitMode: update.mode,
        ...(update.keyEpoch === undefined ? {} : { keyEpoch: update.keyEpoch }),
        previousRevisionId: currentHeads.get(update.namespace)?.revisionId ?? null,
      } satisfies NamespaceRevision;
      writes[namespaceRetentionKey(update.namespace, update.namespaceRevisionId)] = {
        namespace: update.namespace,
        revisionId: update.namespaceRevisionId,
        previousRevisionId: currentHeads.get(update.namespace)?.revisionId ?? null,
        mode: update.mode === "append" ? "delta" : "snapshot",
        objectIds: [...new Set([update.manifestObjectId, ...update.requiredObjectIds])].sort((left, right) => left.localeCompare(right, "en")),
        retainedVaultRevisionIds: [...new Set(update.retainedVaultRevisionIds ?? [])].sort((left, right) => left.localeCompare(right, "en")),
        committedAt: effectiveCommittedAt,
        operationId: request.operationId,
      } satisfies NamespaceRetentionMetadata;
      writes[namespacePathsKey(update.namespace)] = [...nextPaths.get(update.namespace)!].sort((left, right) => left.localeCompare(right, "en"));
    }
    writes[NAMESPACE_NAMES_KEY] = [...names].sort((left, right) => left.localeCompare(right, "en"));
    const projectedHeads = new Map((await this.namespaceHeads()).map((head) => [head.namespace, head]));
    for (const update of request.updates) {
      projectedHeads.set(update.namespace, writes[namespaceHeadKey(update.namespace)] as NamespaceHead);
    }
    writes[`scoped:revision:${request.vaultRevisionId}`] = {
      revisionId: request.vaultRevisionId,
      previousRevisionId,
      namespaces: [...projectedHeads.values()].sort((left, right) => left.namespace.localeCompare(right.namespace, "en")),
    } satisfies ScopedVaultRevision;
    writes[RETENTION_TRACKED_SINCE_KEY] = (await this.#storage.get<number>(RETENTION_TRACKED_SINCE_KEY)) ?? effectiveCommittedAt;
    await this.#storage.putMany(writes);
    return result;
  }

  async planGarbageCollection(input: {
    id: string;
    now: number;
    gracePeriodMs: number;
    policy: Readonly<RetentionPolicy>;
    candidates: readonly GarbageObjectCandidate[];
    dryRun: boolean;
    leaseMs?: number;
  }): Promise<GarbageCollectionPlanResult> {
    if (!input.id) throw new TypeError("garbage-collection plan ID is required");
    assertTimestamp(input.now, "garbage-collection time");
    if (!Number.isSafeInteger(input.gracePeriodMs) || input.gracePeriodMs < 0) throw new TypeError("garbage-collection grace period is invalid");
    const leaseMs = input.leaseMs ?? DEFAULT_GC_LEASE_MS;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 15 * 60_000) throw new TypeError("garbage-collection lease is invalid");
    if (input.candidates.length > 100_000) throw new TypeError("garbage-collection candidate limit exceeded");
    const candidateIdentities = new Set<string>();
    for (const candidate of input.candidates) {
      validateGarbageCandidate(candidate);
      const identity = objectReferenceKey(candidate.namespace ?? "$legacy", candidate.objectId);
      if (candidateIdentities.has(identity)) throw new TypeError("duplicate garbage-collection candidate");
      candidateIdentities.add(identity);
    }
    if (!input.dryRun) {
      const active = await this.#activeGarbageCollection();
      if (active && active.expiresAt > input.now) {
        return { outcome: "busy", planId: active.id, retryAfterMs: active.expiresAt - input.now };
      }
      if (active) await this.#finalizeGarbageCollectionMetadata(active);
    }

    const scopedMetadata = await this.#storage.list<ScopedRetentionMetadata>("retention:scoped:revision:", MAX_RETENTION_GRAPH);
    const history = [...scopedMetadata.values()].sort((left, right) =>
      right.sequence - left.sequence || right.revisionId.localeCompare(left.revisionId, "en"));
    const checkpoints = selectRetentionCheckpoints(history, input.now, input.policy);
    const roots = new Set(checkpoints.map((checkpoint) => checkpoint.revisionId));
    const current = await this.scopedHead();
    if (current) roots.add(current.revisionId);
    for (const snapshot of await this.listSnapshots()) {
      if (snapshot.protocolVersion === "1.1") roots.add(snapshot.revisionId);
    }
    const graph = await this.#retentionGraph(roots);

    const trackedSince = (await this.#storage.get<number>(RETENTION_TRACKED_SINCE_KEY)) ?? null;
    const cutoff = input.now - input.gracePeriodMs;
    const deleteObjects = graph.globalConservative || trackedSince === null
      ? []
      : input.candidates.filter((candidate) => {
        return candidate.namespace !== null &&
          candidate.uploadedAt >= trackedSince &&
          candidate.uploadedAt <= cutoff &&
          !graph.conservativeScopes.has(candidate.namespace) &&
          !graph.reachableObjects.has(objectReferenceKey(candidate.namespace, candidate.objectId));
      }).sort(compareGarbageCandidates);
    const deleteBytes = deleteObjects.reduce((total, candidate) => {
      const next = total + candidate.size;
      if (!Number.isSafeInteger(next)) throw new TypeError("garbage-collection total size is invalid");
      return next;
    }, 0);
    const expiresAt = input.dryRun ? null : input.now + leaseMs;
    const plan: GarbageCollectionPlan = {
      id: input.id,
      createdAt: input.now,
      expiresAt,
      gracePeriodMs: input.gracePeriodMs,
      trackedSince,
      checkpoints,
      reachableVaultRevisionIds: [...graph.reachableVaultRevisionIds].sort((left, right) => left.localeCompare(right, "en")),
      reachableNamespaceRevisionIds: [...graph.reachableNamespaceRevisionIds].map((identity) => {
        const [namespace, revisionId] = splitObjectReferenceKey(identity);
        return { namespace, revisionId };
      }).sort((left, right) => left.namespace.localeCompare(right.namespace, "en") || left.revisionId.localeCompare(right.revisionId, "en")),
      reachableObjects: [...graph.reachableObjects].map((identity) => {
        const [namespace, objectId] = splitObjectReferenceKey(identity);
        return { namespace, objectId };
      }).sort((left, right) => left.namespace.localeCompare(right.namespace, "en") || left.objectId.localeCompare(right.objectId, "en")),
      deleteObjects,
      deleteBytes,
      conservativeScopes: [...graph.conservativeScopes].sort((left, right) => left.localeCompare(right, "en")),
    };
    if (!input.dryRun) {
      await this.#storage.putMany({
        [ACTIVE_GC_KEY]: {
          id: input.id,
          expiresAt: input.now + leaseMs,
          checkpoints,
          rootVaultRevisionIds: [...roots].sort((left, right) => left.localeCompare(right, "en")),
        } satisfies ActiveGarbageCollection,
      });
    }
    return { outcome: "planned", plan };
  }

  async finalizeGarbageCollection(planId: string): Promise<boolean> {
    const active = await this.#storage.get<ActiveGarbageCollection>(ACTIVE_GC_KEY);
    if (!active || active.id !== planId) return false;
    await this.#finalizeGarbageCollectionMetadata(active);
    return true;
  }

  async #activeGarbageCollection(): Promise<ActiveGarbageCollection | undefined> {
    return this.#storage.get<ActiveGarbageCollection>(ACTIVE_GC_KEY);
  }

  async #finalizeGarbageCollectionMetadata(active: ActiveGarbageCollection): Promise<void> {
    const graph = await this.#retentionGraph(new Set(active.rootVaultRevisionIds));
    const deletes = [ACTIVE_GC_KEY];
    const scoped = await this.#storage.list<ScopedRetentionMetadata>("retention:scoped:revision:", MAX_RETENTION_GRAPH);
    for (const [key, metadata] of scoped) {
      if (graph.globalConservative || graph.reachableVaultRevisionIds.has(metadata.revisionId)) continue;
      deletes.push(key, `scoped:revision:${metadata.revisionId}`, `scoped:operation:${metadata.operationId}`);
    }
    const namespaces = await this.#storage.list<NamespaceRetentionMetadata>("retention:namespace:", MAX_RETENTION_GRAPH);
    for (const [key, metadata] of namespaces) {
      if (graph.globalConservative || graph.conservativeScopes.has(metadata.namespace) ||
          graph.reachableNamespaceRevisionIds.has(objectReferenceKey(metadata.namespace, metadata.revisionId))) continue;
      deletes.push(key, namespaceRevisionKey(metadata.namespace, metadata.revisionId));
    }
    await this.#storage.putMany({ [RETENTION_CHECKPOINTS_KEY]: active.checkpoints });
    await this.#storage.deleteMany(deletes);
  }

  async #retentionGraph(roots: ReadonlySet<string>): Promise<RetentionGraph> {
    const reachableVaultRevisionIds = new Set<string>();
    const reachableNamespaceRevisionIds = new Set<string>();
    const reachableObjects = new Set<string>();
    const conservativeScopes = new Set<string>(["legacy"]);
    const pendingRoots = [...roots];
    let graphNodes = 0;
    let globalConservative = false;
    while (pendingRoots.length > 0) {
      const revisionId = pendingRoots.shift()!;
      if (reachableVaultRevisionIds.has(revisionId)) continue;
      if (++graphNodes > MAX_RETENTION_GRAPH) throw new Error("retention graph exceeds the safety limit");
      const revision = await this.scopedRevision(revisionId);
      if (!revision) {
        globalConservative = true;
        break;
      }
      reachableVaultRevisionIds.add(revisionId);
      for (const head of revision.namespaces) {
        let namespaceRevision = await this.namespaceRevision(head.namespace, head.revisionId);
        if (!namespaceRevision) {
          conservativeScopes.add(head.namespace);
          continue;
        }
        while (namespaceRevision) {
          const identity = objectReferenceKey(head.namespace, namespaceRevision.revisionId);
          if (reachableNamespaceRevisionIds.has(identity)) break;
          if (++graphNodes > MAX_RETENTION_GRAPH) throw new Error("retention graph exceeds the safety limit");
          reachableNamespaceRevisionIds.add(identity);
          const metadata = await this.#storage.get<NamespaceRetentionMetadata>(
            namespaceRetentionKey(head.namespace, namespaceRevision.revisionId),
          );
          if (!metadata) {
            conservativeScopes.add(head.namespace);
            break;
          }
          for (const objectId of metadata.objectIds) reachableObjects.add(objectReferenceKey(head.namespace, objectId));
          for (const retainedRevisionId of metadata.retainedVaultRevisionIds) {
            if (!reachableVaultRevisionIds.has(retainedRevisionId)) pendingRoots.push(retainedRevisionId);
          }
          if (metadata.mode === "snapshot" || !metadata.previousRevisionId) break;
          namespaceRevision = await this.namespaceRevision(head.namespace, metadata.previousRevisionId);
          if (!namespaceRevision) conservativeScopes.add(head.namespace);
        }
      }
    }
    return {
      reachableVaultRevisionIds,
      reachableNamespaceRevisionIds,
      reachableObjects,
      conservativeScopes,
      globalConservative,
    };
  }
}

export class InMemoryCoordinatorStorage implements CoordinatorStorage {
  readonly #values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.#values.get(key) as T | undefined;
  }

  async putMany(entries: Readonly<Record<string, unknown>>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) this.#values.set(key, structuredClone(value));
  }

  async list<T>(prefix: string, limit: number): Promise<Map<string, T>> {
    const output = new Map<string, T>();
    for (const [key, value] of this.#values) {
      if (!key.startsWith(prefix)) continue;
      if (output.size >= limit) throw new Error("coordinator storage listing exceeds the safety limit");
      output.set(key, structuredClone(value) as T);
    }
    return output;
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.#values.delete(key);
  }
}

function namespaceHeadKey(namespace: string): string {
  return `scoped:namespace:${namespace}:head`;
}

function namespacePathsKey(namespace: string): string {
  return `scoped:namespace:${namespace}:paths`;
}

function namespaceRevisionKey(namespace: string, revisionId: string): string {
  return `scoped:namespace:${namespace}:revision:${revisionId}`;
}

function scopedRetentionKey(revisionId: string): string {
  return `retention:scoped:revision:${revisionId}`;
}

function namespaceRetentionKey(namespace: string, revisionId: string): string {
  return `retention:namespace:${namespace}:revision:${revisionId}`;
}

function objectReferenceKey(namespace: string, objectId: string): string {
  return `${namespace}\0${objectId}`;
}

function splitObjectReferenceKey(value: string): [string, string] {
  const separator = value.indexOf("\0");
  if (separator < 1) throw new Error("invalid retained object reference");
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function validateGarbageCandidate(candidate: GarbageObjectCandidate): void {
  if (candidate.namespace !== null && !RETENTION_IDENTIFIER.test(candidate.namespace)) {
    throw new TypeError("garbage-collection namespace is invalid");
  }
  if (!RETENTION_IDENTIFIER.test(candidate.objectId)) throw new TypeError("garbage-collection object ID is invalid");
  assertTimestamp(candidate.uploadedAt, "garbage-collection upload time");
  if (!Number.isSafeInteger(candidate.size) || candidate.size < 0) throw new TypeError("garbage-collection object size is invalid");
}

function compareGarbageCandidates(left: GarbageObjectCandidate, right: GarbageObjectCandidate): number {
  return (left.namespace ?? "").localeCompare(right.namespace ?? "", "en") || left.objectId.localeCompare(right.objectId, "en");
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid`);
}

async function requestFingerprint(request: CommitRequest | ScopedCommitRequest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(request));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(new Uint8Array(digest));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
