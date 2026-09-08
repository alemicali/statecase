import { chmod, constants, copyFile, lstat, mkdir, open, readlink, rename, rm, symlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

import { assertTemporarySpace } from "./disk-space.js";

interface MaterializedWriteBase {
  path: string;
  mode?: number;
}

export type MaterializedWrite = MaterializedWriteBase & (
  | { bytes: Uint8Array; sourcePath?: never }
  | { bytes?: never; sourcePath: string }
);

export interface FileTransaction {
  writes: readonly MaterializedWrite[];
  symlinks?: ReadonlyArray<{ path: string; target: string }>;
  deletes: readonly string[];
  /** Fault-injection boundary used by isolated recovery tests. */
  beforeCommit?: (index: number, path: string) => void | Promise<void>;
}

interface PreparedTarget {
  path: string;
  staging?: string;
  backup?: string;
  installed: boolean;
  mode?: number;
  symbolic?: boolean;
  installedFingerprint?: string;
  preserveBackup?: boolean;
}

/** Applies one remote revision as an all-or-rollback local filesystem transaction. */
export async function applyFileTransaction(transaction: FileTransaction): Promise<void> {
  const transactionId = crypto.randomUUID();
  const targets: PreparedTarget[] = [
    ...transaction.writes.map((write) => ({ path: resolve(write.path), installed: false, mode: write.mode })),
    ...(transaction.symlinks ?? []).map((link) => ({ path: resolve(link.path), installed: false, symbolic: true })),
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
      if (write.sourcePath === undefined) {
        await assertTemporarySpace(dirname(target.staging), write.bytes.byteLength);
        const handle = await open(target.staging, "wx", 0o600);
        try {
          await handle.writeFile(write.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        const source = await lstat(write.sourcePath);
        if (!source.isFile()) throw new Error("file-backed transaction source is not a regular file");
        await assertTemporarySpace(dirname(target.staging), source.size);
        await copyFile(write.sourcePath, target.staging, constants.COPYFILE_EXCL);
        const copied = await open(target.staging, "r");
        try { await copied.sync(); } finally { await copied.close(); }
      }
      // Prepare permissions before installation, so no chmod failure can leave
      // an installed destination whose ownership has not been recorded yet.
      if (target.mode !== undefined) await chmod(target.staging, target.mode);
      target.installedFingerprint = await targetFingerprint(target.staging);
    }
    for (let index = 0; index < (transaction.symlinks?.length ?? 0); index += 1) {
      const link = transaction.symlinks![index];
      const target = targets[transaction.writes.length + index];
      await mkdir(dirname(target.path), { recursive: true, mode: 0o700 });
      target.staging = `${target.path}.statecase-transaction-${transactionId}.staged`;
      await symlink(link.target, target.staging);
      target.installedFingerprint = await targetFingerprint(target.staging);
    }

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      await transaction.beforeCommit?.(index, target.path);
      const existing = await optionalLstat(target.path);
      if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
        throw new Error(`refusing to replace non-regular file: ${target.path}`);
      }
      if (existing) {
        const backup = `${target.path}.statecase-transaction-${transactionId}.backup`;
        await rename(target.path, backup);
        target.backup = backup;
      }
      if (target.staging) await rename(target.staging, target.path);
      target.installed = true;
    }
  } catch (cause) {
    const rollbackErrors: unknown[] = [];
    for (const target of [...targets].reverse()) {
      try {
        if ((target.installed || target.backup) &&
            await targetFingerprint(target.path) !== (target.installed ? target.installedFingerprint ?? "absent" : "absent")) {
          throw new Error("destination changed independently; preserving local work and recovery backup");
        }
        if (target.installed && target.staging) await rm(target.path, { force: true });
        if (target.backup) await rename(target.backup, target.path);
      } catch (error) {
        target.preserveBackup = true;
        rollbackErrors.push(error);
      }
    }
    await cleanupTemporary(targets);
    if (rollbackErrors.length > 0) throw new AggregateError([cause, ...rollbackErrors], "materialization failed and rollback was incomplete; available recovery backups retained");
    throw cause;
  }

  await cleanupTemporary(targets);
}

async function cleanupTemporary(targets: readonly PreparedTarget[]): Promise<void> {
  await Promise.all(targets.flatMap((target) => [target.staging, target.preserveBackup ? undefined : target.backup]
    .filter((path): path is string => Boolean(path))
    .map((path) => rm(path, { force: true }))));
}

/** Rename preserves inode, content, mode, and mtime, but may change ctime. */
async function targetFingerprint(path: string): Promise<string> {
  const info = await optionalLstat(path);
  if (!info) return "absent";
  if (!info.isFile() && !info.isSymbolicLink()) return "non-file";
  let content: string;
  if (info.isSymbolicLink()) content = await readlink(path);
  else {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    content = hash.digest("hex");
  }
  return JSON.stringify([info.dev, info.ino, info.mode, info.size, info.mtimeMs, content]);
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
