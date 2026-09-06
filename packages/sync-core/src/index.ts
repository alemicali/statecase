import {
  canonicalJson,
  commitRequestSchema,
  scopedCommitRequestSchema,
  type CommitRequest,
  type ScopedCommitRequest,
  type VaultManifestV1,
} from "@statecase/protocol";

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
  return canonicalJson(left.value) === canonicalJson((right as Extract<PathState, { kind: "entry" }>).value);
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
  putMany(entries: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface VaultHead {
  revisionId: string;
  manifestObjectId: string;
}

export interface VaultRevision extends VaultHead {
  previousRevisionId: string | null;
}

export interface VaultSnapshot extends VaultHead {
  id: string;
  name: string;
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
  | { outcome: "stale-base"; currentRevisionId: string | null };

interface StoredOperation {
  fingerprint: string;
  result: Extract<CommitResult, { outcome: "committed" }>;
}

export interface NamespaceHead {
  namespace: string;
  revisionId: string;
  manifestObjectId: string;
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
const MAX_SNAPSHOTS = 1_000;

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
    const head = await this.head();
    if (!head) return { outcome: "no-head" };
    if (snapshots.length >= MAX_SNAPSHOTS) throw new Error("snapshot limit reached");
    const snapshot: VaultSnapshot = { id: input.id, name: input.name, ...head, protected: true, createdAt: input.createdAt };
    await this.#storage.putMany({ [SNAPSHOTS_KEY]: [...snapshots, snapshot] });
    return { outcome: "created", snapshot };
  }

  async deleteSnapshot(snapshotId: string): Promise<boolean> {
    const snapshots = await this.listSnapshots();
    if (!snapshots.some((snapshot) => snapshot.id === snapshotId)) return false;
    await this.#storage.putMany({ [SNAPSHOTS_KEY]: snapshots.filter((snapshot) => snapshot.id !== snapshotId) });
    return true;
  }

  async commit(unknownRequest: CommitRequest): Promise<CommitResult> {
    const request = commitRequestSchema.parse(unknownRequest);
    const fingerprint = await requestFingerprint(request);
    const operationKey = `operation:${request.operationId}`;
    const existing = await this.#storage.get<StoredOperation>(operationKey);
    if (existing) {
      return existing.fingerprint === fingerprint ? existing.result : { outcome: "idempotency-conflict" };
    }

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
  async commitNamespaces(unknownRequest: ScopedCommitRequest): Promise<ScopedCommitResult> {
    const request = scopedCommitRequestSchema.parse(unknownRequest);
    const fingerprint = await requestFingerprint(request);
    const operationKey = `scoped:operation:${request.operationId}`;
    const existing = await this.#storage.get<StoredScopedOperation>(operationKey);
    if (existing) return existing.fingerprint === fingerprint ? existing.result : { outcome: "idempotency-conflict" };

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
    const result = { outcome: "committed" as const, revisionId: request.vaultRevisionId, previousRevisionId };
    const names = new Set((await this.#storage.get<string[]>(NAMESPACE_NAMES_KEY)) ?? []);
    const writes: Record<string, unknown> = {
      [SCOPED_HEAD_KEY]: { revisionId: request.vaultRevisionId } satisfies ScopedVaultHead,
      [operationKey]: { fingerprint, result } satisfies StoredScopedOperation,
    };
    for (const update of request.updates) {
      names.add(update.namespace);
      writes[namespaceHeadKey(update.namespace)] = {
        namespace: update.namespace,
        revisionId: update.namespaceRevisionId,
        manifestObjectId: update.manifestObjectId,
      } satisfies NamespaceHead;
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
    await this.#storage.putMany(writes);
    return result;
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
}

function namespaceHeadKey(namespace: string): string {
  return `scoped:namespace:${namespace}:head`;
}

function namespacePathsKey(namespace: string): string {
  return `scoped:namespace:${namespace}:paths`;
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
