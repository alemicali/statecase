import { canonicalJson, commitRequestSchema, type CommitRequest } from "@statecase/protocol";

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

const HEAD_KEY = "head";
const SNAPSHOTS_KEY = "snapshots";
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

async function requestFingerprint(request: CommitRequest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(request));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(new Uint8Array(digest));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
