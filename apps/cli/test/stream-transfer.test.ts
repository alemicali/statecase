import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeObjectId, deriveScopeKey, encryptEnvelope, randomKey } from "@statecase/crypto";
import { afterEach, describe, expect, it } from "vitest";

import { describeStagedJsonl, downloadVerifiedEntry, uploadStagedJsonl } from "../src/stream-transfer.js";

const policy = { targetSize: 8, maxSize: 12 };
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bounded encrypted stream transfer (PERF-003, AD-CX-008)", () => {
  it("describes and uploads only requested chunks in real and dry-run modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-stream-upload-"));
    temporary.push(root);
    const path = join(root, "session.jsonl");
    await writeFile(path, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const keys = await deriveScopeKey(await randomKey(), "harness:codex:default");
    const described = await describeStagedJsonl(path, keys.dedupKey, policy);
    expect(described.objectIds).toHaveLength(3);
    const uploaded: string[] = [];
    const result = await uploadStagedJsonl({
      path,
      policy,
      requiredObjectIds: new Set([described.objectIds[1]!]),
      keys,
      vaultId: "vlt_test",
      namespace: "harness:codex:default",
      dryRun: false,
      putObject: async (objectId) => { uploaded.push(objectId); },
    });
    expect(uploaded).toEqual([described.objectIds[1]]);
    expect(result).toMatchObject({ objects: 1, bytes: expect.any(Number) });

    uploaded.length = 0;
    expect(await uploadStagedJsonl({
      path,
      policy,
      requiredObjectIds: new Set([described.objectIds[0]!]),
      keys,
      vaultId: "vlt_test",
      namespace: "harness:codex:default",
      dryRun: true,
      putObject: async (objectId) => { uploaded.push(objectId); },
    })).toMatchObject({ objects: 1 });
    expect(uploaded).toEqual([]);
    await expect(uploadStagedJsonl({
      path,
      policy,
      requiredObjectIds: new Set(["obj_missing"]),
      keys,
      vaultId: "vlt_test",
      namespace: "harness:codex:default",
      dryRun: true,
      putObject: async () => undefined,
    })).rejects.toThrow("could not be materialized");
  });

  it("downloads, authenticates, verifies, and disposes a multi-object entry", async () => {
    const rootKey = await randomKey();
    const keys = await deriveScopeKey(rootKey, "scope");
    const chunks = [new TextEncoder().encode("first"), new TextEncoder().encode("second")];
    const objectIds = await Promise.all(chunks.map((chunk) => computeObjectId(keys.dedupKey, chunk)));
    const envelopes = new Map<string, Uint8Array>();
    for (const [index, objectId] of objectIds.entries()) envelopes.set(objectId, await encryptEnvelope({
      plaintext: chunks[index]!, key: keys.encryptionKey, dedupKey: keys.dedupKey,
      context: { vaultId: "vlt_test", scopeId: "scope", compression: "none" },
    }));
    const body = new TextEncoder().encode("firstsecond");
    let transferred = 0;
    const staged = await downloadVerifiedEntry({
      objectIds,
      totalSize: body.byteLength,
      contentDigest: await computeObjectId(keys.dedupKey, body),
      maximumSize: 100,
      keys,
      vaultId: "vlt_test",
      namespace: "scope",
      getObject: async (id) => envelopes.get(id)!,
      onEnvelope: (bytes) => { transferred += bytes; },
    });
    expect(await readFile(staged.path)).toEqual(Buffer.from(body));
    expect(transferred).toBeGreaterThan(body.byteLength);
    const path = staged.path;
    await staged.dispose();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes staging after authentication, declared-size, and digest failures", async () => {
    const keys = await deriveScopeKey(await randomKey(), "scope");
    const bytes = new TextEncoder().encode("payload");
    const objectId = await computeObjectId(keys.dedupKey, bytes);
    const envelope = await encryptEnvelope({ plaintext: bytes, key: keys.encryptionKey, dedupKey: keys.dedupKey, context: { vaultId: "vlt_test", scopeId: "scope", compression: "none" } });
    const base = { objectIds: [objectId], keys, vaultId: "vlt_test", namespace: "scope", getObject: async () => envelope };
    await expect(downloadVerifiedEntry({ ...base, totalSize: 1, contentDigest: objectId, maximumSize: 100 })).rejects.toThrow("declared size");
    await expect(downloadVerifiedEntry({ ...base, totalSize: bytes.byteLength, contentDigest: "obj_wrong", maximumSize: 100 })).rejects.toThrow("content verification");
    await expect(downloadVerifiedEntry({ ...base, totalSize: bytes.byteLength, contentDigest: objectId, maximumSize: 1 })).rejects.toThrow("declared size");
    const corrupt = envelope.slice();
    corrupt[corrupt.length - 1] ^= 1;
    await expect(downloadVerifiedEntry({ ...base, totalSize: bytes.byteLength, contentDigest: objectId, maximumSize: 100, getObject: async () => corrupt }))
      .rejects.toThrow("authentication failed");
  });
});
