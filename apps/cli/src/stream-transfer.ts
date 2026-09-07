import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chunkJsonlStream, type JsonlStreamPolicy } from "@statecase/chunking";
import { computeObjectId, computeObjectIdStream, decryptEnvelope, encryptEnvelope } from "@statecase/crypto";

export interface TransferKeys {
  encryptionKey: Uint8Array;
  dedupKey: Uint8Array;
}

export async function describeStagedJsonl(
  path: string,
  dedupKey: Uint8Array,
  policy: JsonlStreamPolicy,
): Promise<{ objectIds: string[]; contentDigest: string }> {
  const objectIds: string[] = [];
  for await (const chunk of chunkJsonlStream(createReadStream(path), policy)) {
    objectIds.push(await computeObjectId(dedupKey, chunk));
  }
  return {
    objectIds,
    contentDigest: await computeObjectIdStream(dedupKey, createReadStream(path)),
  };
}

export async function uploadStagedJsonl(input: {
  path: string;
  policy: JsonlStreamPolicy;
  requiredObjectIds: ReadonlySet<string>;
  keys: TransferKeys;
  vaultId: string;
  namespace: string;
  dryRun: boolean;
  putObject(objectId: string, envelope: Uint8Array): Promise<void>;
}): Promise<{ objects: number; bytes: number }> {
  const pending = new Set(input.requiredObjectIds);
  let objects = 0;
  let bytes = 0;
  for await (const plaintext of chunkJsonlStream(createReadStream(input.path), input.policy)) {
    const objectId = await computeObjectId(input.keys.dedupKey, plaintext);
    if (!pending.has(objectId)) continue;
    const envelope = await encryptEnvelope({
      plaintext,
      key: input.keys.encryptionKey,
      dedupKey: input.keys.dedupKey,
      context: { vaultId: input.vaultId, scopeId: input.namespace, compression: "none" },
    });
    objects += 1;
    bytes += envelope.byteLength;
    if (!input.dryRun) await input.putObject(objectId, envelope);
    pending.delete(objectId);
  }
  if (pending.size > 0) throw new Error("manifest references local objects that could not be materialized");
  return { objects, bytes };
}

export async function downloadVerifiedEntry(input: {
  objectIds: readonly string[];
  totalSize: number;
  contentDigest: string;
  maximumSize: number;
  keys: TransferKeys;
  vaultId: string;
  namespace: string;
  getObject(objectId: string): Promise<Uint8Array>;
  onEnvelope?(bytes: number): void;
}): Promise<{ root: string; path: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "statecase-download-"));
  const path = join(root, "portable.staged");
  const destination = await open(path, "wx", 0o600);
  let plaintextBytes = 0;
  try {
    for (const objectId of input.objectIds) {
      const envelope = await input.getObject(objectId);
      input.onEnvelope?.(envelope.byteLength);
      const chunk = await decryptEnvelope({
        envelope,
        key: input.keys.encryptionKey,
        dedupKey: input.keys.dedupKey,
        expected: { vaultId: input.vaultId, scopeId: input.namespace, compression: "none" },
      });
      plaintextBytes += chunk.byteLength;
      if (plaintextBytes > input.totalSize || plaintextBytes > input.maximumSize) {
        throw new Error("downloaded session exceeds its declared size");
      }
      await destination.write(chunk);
    }
    await destination.sync();
  } catch (error) {
    await destination.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  await destination.close();
  if (plaintextBytes !== input.totalSize || await computeObjectIdStream(input.keys.dedupKey, createReadStream(path)) !== input.contentDigest) {
    await rm(root, { recursive: true, force: true });
    throw new Error("downloaded file failed content verification");
  }
  return { root, path, dispose: () => rm(root, { recursive: true, force: true }) };
}
