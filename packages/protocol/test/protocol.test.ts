import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  commitRequestSchema,
  manifestEntrySchema,
  manifestSchema,
  protocolError,
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
});
