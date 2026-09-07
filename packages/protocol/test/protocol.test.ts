import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  commitRequestSchema,
  manifestEntrySchema,
  manifestSchema,
  namespaceManifestSchema,
  protocolError,
  scopedCommitRequestSchema,
  sessionCapsuleSchema,
} from "../src/index.js";

describe("canonical protocol encoding (SY-001, PR-001)", () => {
  it("sorts object keys recursively and preserves array order", () => {
    const left = { z: 1, a: { y: [3, { b: 2, a: 1 }], x: true } };
    const right = { a: { x: true, y: [3, { a: 1, b: 2 }] }, z: 1 };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalJson(left)).toBe(
      '{"a":{"x":true,"y":[3,{"a":1,"b":2}]},"z":1}',
    );
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n])(
    "rejects non-canonical value %s",
    (value) => expect(() => canonicalJson({ value })).toThrow("canonical"),
  );

  it("rejects cyclic structures", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("cycle");
  });

  it("normalizes negative zero and accepts null-prototype records", () => {
    const record = Object.create(null) as Record<string, unknown>;
    record.zero = -0;
    record.value = null;
    expect(canonicalJson(record)).toBe('{"value":null,"zero":0}');
  });

  it("rejects class instances", () => {
    expect(() => canonicalJson(new Date())).toThrow("plain objects");
  });
});

describe("wire schemas (PR-001, PR-014)", () => {
  const manifest = {
    schemaVersion: 1,
    vaultId: "vlt_01",
    revisionId: "rev_01",
    parentRevisionIds: [],
    createdAt: "2026-09-06T10:00:00.000Z",
    createdByDeviceId: "dev_01",
    operationId: "op_01",
    entries: [],
    tombstones: [],
    conflicts: [],
  };

  it("accepts a v1 manifest and rejects an unknown required version", () => {
    expect(manifestSchema.parse(manifest)).toEqual(manifest);
    expect(() => manifestSchema.parse({ ...manifest, schemaVersion: 2 })).toThrow();
  });

  it("defaults legacy entries to files and preserves fail-closed workspace metadata", () => {
    const legacy = { namespace: "drop:one", logicalPath: "a.txt", objectIds: ["obj_a"], totalSize: 1, contentDigest: "obj_digest" };
    expect(manifestEntrySchema.parse(legacy)).toMatchObject({ entryType: "file" });
    expect(manifestEntrySchema.parse({
      ...legacy,
      entryType: "workspace-blob",
      workspacePath: "src/a.txt",
      workspaceLayer: "index",
      fileMode: 0o100755,
    })).toMatchObject({ entryType: "workspace-blob", workspaceLayer: "index", fileMode: 0o100755 });
  });

  it("records bounded chunking parameters while accepting manifests written before the descriptor existed", () => {
    const entry = { namespace: "harness:codex:default", logicalPath: "portable-sessions/ws/a.jsonl", objectIds: ["obj_a"], totalSize: 1, contentDigest: "obj_digest" };
    expect(manifestEntrySchema.parse(entry).chunking).toBeUndefined();
    expect(manifestEntrySchema.parse({
      ...entry,
      chunking: { strategy: "jsonl-records", targetSize: 4 * 1024 * 1024, maxSize: 4 * 1024 * 1024 },
    }).chunking).toMatchObject({ strategy: "jsonl-records" });
    expect(() => manifestEntrySchema.parse({ ...entry, chunking: { strategy: "jsonl-records", targetSize: 5, maxSize: 4 } })).toThrow();
    expect(() => manifestEntrySchema.parse({ ...entry, chunking: { strategy: "unknown", size: 4 } })).toThrow();
  });

  it("validates a commit request and idempotency key", () => {
    const request = {
      protocolVersion: "1.0",
      operationId: "op_01",
      baseRevisionId: null,
      revisionId: "rev_01",
      manifestObjectId: "obj_manifest",
      requiredObjectIds: ["obj_a"],
    };
    expect(commitRequestSchema.parse(request)).toEqual(request);
    expect(() => commitRequestSchema.parse({ ...request, operationId: "" })).toThrow();
  });

  it("serializes public errors without causes or sensitive detail", () => {
    expect(protocolError("AUTH_REQUIRED", "login required", 401, new Error("token=secret"))).toEqual({
      code: "AUTH_REQUIRED",
      message: "login required",
      status: 401,
    });
  });

  it("accepts a closed session dependency graph and rejects incomplete identities", () => {
    const capsule = {
      sessionCapsuleId: "cap_01",
      sessionKey: "vlt_01:codex:default:ws_01:native_01",
      harnessRevisionId: "rev_01",
      harness: { namespace: "harness:codex:default", logicalPath: "portable-sessions/ws_01/native_01.jsonl" },
      workspace: { workspaceId: "ws_01", capsuleRevisionId: "rev_01", baseCommit: "a".repeat(40) },
      drops: [{ dropId: "drop_docs", revisionId: "rev_01" }],
      dependencies: [
        { logicalPath: "src/index.ts", source: "git-baseline", gitObjectId: "b".repeat(40), required: true },
        { logicalPath: "drop_docs/brief.md", source: "drop", contentDigest: "digest_01", required: true },
        { logicalPath: "/outside/private.txt", source: "external", required: true },
      ],
      createdAt: "2026-09-06T10:00:00.000Z",
      createdByDeviceId: "dev_01",
    };
    expect(sessionCapsuleSchema.parse(capsule)).toEqual(capsule);
    expect(() => sessionCapsuleSchema.parse({ ...capsule, sessionCapsuleId: "" })).toThrow();
    expect(() => sessionCapsuleSchema.parse({ ...capsule, dependencies: [{ ...capsule.dependencies[0], source: "unknown" }] })).toThrow();
  });

  it("carries session capsules in a manifest without changing legacy manifest parsing", () => {
    const capsule = {
      sessionCapsuleId: "cap_01",
      sessionKey: "vlt_01:claude:default:ws_01:native_01",
      harnessRevisionId: "rev_01",
      harness: { namespace: "harness:claude:default", logicalPath: "portable-sessions/ws_01/native_01.jsonl" },
      workspace: { workspaceId: "ws_01", capsuleRevisionId: "rev_01" },
      drops: [],
      dependencies: [],
      createdAt: "2026-09-06T10:00:00.000Z",
      createdByDeviceId: "dev_01",
    };
    expect(manifestSchema.parse({ ...manifest, sessionCapsules: [capsule] }).sessionCapsules).toEqual([capsule]);
    expect(manifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("validates atomic namespace updates and rejects duplicate scope or path claims", () => {
    const request = {
      protocolVersion: "1.1",
      operationId: "op_scoped",
      vaultRevisionId: "rev_scoped",
      updates: [{
        namespace: "workspace:ws_01",
        baseNamespaceRevisionId: null,
        namespaceRevisionId: "nrev_01",
        manifestObjectId: "obj_manifest_01",
        requiredObjectIds: ["obj_chunk_01"],
        mode: "append",
        pathClaims: [{ pathId: "pth_01", mutation: "add" }],
      }],
    };
    expect(scopedCommitRequestSchema.parse(request)).toEqual(request);
    expect(() => scopedCommitRequestSchema.parse({ ...request, updates: [...request.updates, request.updates[0]] })).toThrow();
    expect(() => scopedCommitRequestSchema.parse({
      ...request,
      updates: [{ ...request.updates[0], pathClaims: [request.updates[0].pathClaims[0], request.updates[0].pathClaims[0]] }],
    })).toThrow();
    expect(() => scopedCommitRequestSchema.parse({
      ...request,
      updates: [{ ...request.updates[0], mode: "append", pathClaims: [{ pathId: "pth_01", mutation: "update" }] }],
    })).toThrow();
  });

  it("accepts a namespace-scoped manifest and rejects cross-namespace content", () => {
    const scoped = {
      schemaVersion: 1,
      vaultId: "vlt_01",
      namespace: "workspace:ws_01",
      namespaceRevisionId: "nrev_01",
      parentNamespaceRevisionIds: [],
      createdAt: "2026-09-06T10:00:00.000Z",
      createdByDeviceId: "dev_01",
      operationId: "op_scoped",
      mode: "snapshot",
      entries: [{
        namespace: "workspace:ws_01",
        logicalPath: "src/index.ts",
        objectIds: ["obj_a"],
        totalSize: 1,
        contentDigest: "digest_a",
      }],
      tombstones: [],
      conflicts: [],
      pathClaims: [{ pathId: "pth_a", mutation: "add" }],
    };
    expect(namespaceManifestSchema.parse(scoped)).toMatchObject({ namespace: "workspace:ws_01", mode: "snapshot" });
    expect(() => namespaceManifestSchema.parse({
      ...scoped,
      entries: [{ ...scoped.entries[0], namespace: "drop:private" }],
    })).toThrow("manifest namespace");
  });

  it("requires append namespace manifests to be additive and internally unique", () => {
    const append = {
      schemaVersion: 1,
      vaultId: "vlt_01",
      namespace: "harness:codex:default",
      namespaceRevisionId: "nrev_02",
      parentNamespaceRevisionIds: ["nrev_01"],
      createdAt: "2026-09-06T10:00:00.000Z",
      createdByDeviceId: "dev_01",
      operationId: "op_append",
      mode: "delta",
      entries: [{ namespace: "harness:codex:default", logicalPath: "sessions/run.jsonl", objectIds: ["obj_a"], totalSize: 1, contentDigest: "digest_a" }],
      tombstones: [],
      conflicts: [],
      pathClaims: [{ pathId: "pth_a", mutation: "add" }],
    };
    expect(namespaceManifestSchema.parse(append)).toMatchObject({ mode: "delta" });
    expect(namespaceManifestSchema.parse({ ...append, tombstones: [{ namespace: append.namespace, logicalPath: "old", deletedAt: append.createdAt }] }).tombstones).toHaveLength(1);
    expect(() => namespaceManifestSchema.parse({ ...append, pathClaims: [{ pathId: "pth_a", mutation: "update" }] })).toThrow("delta manifests");
    expect(() => namespaceManifestSchema.parse({ ...append, entries: [...append.entries, append.entries[0]] })).toThrow("duplicate logical path");
    expect(() => namespaceManifestSchema.parse({
      ...append,
      tombstones: [{ namespace: append.namespace, logicalPath: append.entries[0].logicalPath, deletedAt: append.createdAt }],
    })).toThrow("duplicate logical path");
  });
});
