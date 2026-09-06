import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface MaterializedWrite {
  path: string;
  bytes: Uint8Array;
}

export interface FileTransaction {
  writes: readonly MaterializedWrite[];
  deletes: readonly string[];
  /** Fault-injection boundary used by isolated recovery tests. */
  beforeCommit?: (index: number, path: string) => void | Promise<void>;
}

interface PreparedTarget {
  path: string;
  staging?: string;
  backup?: string;
  installed: boolean;
}

/** Applies one remote revision as an all-or-rollback local filesystem transaction. */
export async function applyFileTransaction(transaction: FileTransaction): Promise<void> {
  const transactionId = crypto.randomUUID();
  const targets: PreparedTarget[] = [
    ...transaction.writes.map((write) => ({ path: resolve(write.path), installed: false })),
    ...transaction.deletes.map((path) => ({ path: resolve(path), installed: false })),
  ];
  const unique = new Set(targets.map((target) => target.path));
  if (unique.size !== targets.length) throw new Error("duplicate transaction target");

  try {
    for (let index = 0; index < transaction.writes.length; index += 1) {
      const write = transaction.writes[index];
      const target = targets[index];
      await mkdir(dirname(target.path), { recursive: true, mode: 0o700 });
      target.staging = `${target.path}.statecase-transaction-${transactionId}.staged`;
      const handle = await open(target.staging, "wx", 0o600);
      try {
        await handle.writeFile(write.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      await transaction.beforeCommit?.(index, target.path);
      const existing = await optionalLstat(target.path);
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
        throw new Error(`refusing to replace non-regular file: ${target.path}`);
      }
      if (existing) {
        target.backup = `${target.path}.statecase-transaction-${transactionId}.backup`;
        await rename(target.path, target.backup);
      }
      if (target.staging) await rename(target.staging, target.path);
      target.installed = true;
    }
  } catch (cause) {
    const rollbackErrors: unknown[] = [];
    for (const target of [...targets].reverse()) {
      try {
        if (target.installed && target.staging) await rm(target.path, { force: true });
        if (target.backup) await rename(target.backup, target.path);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    await cleanupTemporary(targets);
    if (rollbackErrors.length > 0) throw new AggregateError([cause, ...rollbackErrors], "materialization failed and rollback was incomplete");
    throw cause;
  }

  await cleanupTemporary(targets);
}

async function cleanupTemporary(targets: readonly PreparedTarget[]): Promise<void> {
  await Promise.all(targets.flatMap((target) => [target.staging, target.backup]
    .filter((path): path is string => Boolean(path))
    .map((path) => rm(path, { force: true }))));
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
