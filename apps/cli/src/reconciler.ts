import { LocalStateStore, type StoredOperation } from "@statecase/storage-local";

import type { HarnessName, ReconcileReason } from "./supervisor.js";

type SyncFunction = (reason: ReconcileReason) => Promise<string | null>;
type ReconcileActor = HarnessName | "daemon";

/**
 * Makes runtime sync intent durable before network or filesystem work begins.
 * The journal intentionally contains only bounded operational metadata.
 */
export class DurableReconciler {
  readonly #owner = `runtime_${crypto.randomUUID()}`;

  constructor(
    readonly store: LocalStateStore,
    readonly sync: SyncFunction,
    readonly harness: ReconcileActor,
  ) {}

  async reconcile(reason: ReconcileReason): Promise<void> {
    this.store.enqueue({
      id: `reconcile_${crypto.randomUUID()}`,
      kind: "runtime-reconcile",
      payload: { harness: this.harness, reason },
    });
    while (true) {
      const operation = this.store.claimNext(this.#owner, 60_000);
      if (!operation) return;
      try {
        const payload = runtimePayload(operation);
        const revisionId = await this.sync(payload.reason);
        this.store.commit(operation.id, revisionId ?? "no-remote-revision");
      } catch {
        this.store.retry(operation.id, "synchronization failed");
        throw new Error("synchronization is queued for retry");
      }
    }
  }
}

function runtimePayload(operation: StoredOperation): { harness: ReconcileActor; reason: ReconcileReason } {
  const value = operation.payload as { harness?: unknown; reason?: unknown };
  if ((value.harness !== "codex" && value.harness !== "claude" && value.harness !== "daemon") ||
      (value.reason !== "preflight" && value.reason !== "periodic" && value.reason !== "final")) {
    throw new Error("invalid runtime journal operation");
  }
  return { harness: value.harness, reason: value.reason };
}
