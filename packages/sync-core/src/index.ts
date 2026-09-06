import { canonicalJson, commitRequestSchema, type CommitRequest } from "@statecase/protocol";

export interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>;
  putMany(entries: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface VaultHead {
  revisionId: string;
  manifestObjectId: string;
}

export type CommitResult =
  | { outcome: "committed"; revisionId: string; previousRevisionId: string | null }
  | { outcome: "idempotency-conflict" }
  | { outcome: "stale-base"; currentRevisionId: string | null };

interface StoredOperation {
  fingerprint: string;
  result: Extract<CommitResult, { outcome: "committed" }>;
}

const HEAD_KEY = "head";

export class VaultCoordinatorCore {
  readonly #storage: CoordinatorStorage;

  constructor(storage: CoordinatorStorage) {
    this.#storage = storage;
  }

  async head(): Promise<VaultHead | null> {
    return (await this.#storage.get<VaultHead>(HEAD_KEY)) ?? null;
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
