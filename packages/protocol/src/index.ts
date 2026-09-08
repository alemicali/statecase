import { z } from "zod";

export const PROTOCOL_VERSION = "1.0" as const;
export const SCOPED_PROTOCOL_VERSION = "1.1" as const;

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonical(value, new Set<object>()));
}

function toCanonical(value: unknown, ancestors: Set<object>): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number has no canonical encoding");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new TypeError("value has no canonical JSON encoding");
  if (ancestors.has(value)) throw new TypeError("canonical JSON cycle detected");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => toCanonical(entry, ancestors));
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("only plain objects have a canonical JSON encoding");
    }
    const source = value as Record<string, unknown>;
    const output: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(source).sort()) output[key] = toCanonical(source[key], ancestors);
    return output;
  } finally {
    ancestors.delete(value);
  }
}

const identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const chunkSize = z.number().int().positive().max(8 * 1024 * 1024);

export const chunkingDescriptorSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("jsonl-records"), targetSize: chunkSize, maxSize: chunkSize }).strict()
    .refine((value) => value.targetSize <= value.maxSize, "targetSize must not exceed maxSize"),
  z.object({ strategy: z.literal("fixed"), size: chunkSize }).strict(),
  z.object({ strategy: z.literal("fastcdc"), minSize: chunkSize, targetSize: chunkSize, maxSize: chunkSize }).strict()
    .refine((value) => value.minSize <= value.targetSize && value.targetSize <= value.maxSize, "invalid FastCDC sizes"),
]);

export const manifestEntrySchema = z.object({
  namespace: z.string().min(1).max(1024),
  keyEpoch: z.number().int().positive().safe().optional(),
  logicalPath: z.string().min(1).max(4096),
  entryType: z.enum(["file", "workspace-capsule", "workspace-blob"]).default("file"),
  workspacePath: z.string().min(1).max(4096).optional(),
  workspaceLayer: z.enum(["index", "worktree"]).optional(),
  fileMode: z.number().int().nonnegative().max(0o160000).optional(),
  objectIds: z.array(identifier).max(10_000),
  totalSize: z.number().int().nonnegative().safe(),
  contentDigest: identifier,
  chunking: chunkingDescriptorSchema.optional(),
}).strict();

export const tombstoneSchema = z.object({
  namespace: z.string().min(1).max(1024),
  logicalPath: z.string().min(1).max(4096),
  deletedAt: z.iso.datetime(),
}).strict();

export const conflictSchema = z.object({
  namespace: z.string().min(1).max(1024),
  logicalPath: z.string().min(1).max(4096),
  variantObjectIds: z.array(identifier).min(2).max(32),
  kind: z.enum(["modify-delete", "binary", "append-fork", "path-collision"]),
}).strict();

const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

export const dependencyReferenceSchema = z.object({
  logicalPath: z.string().min(1).max(4096),
  source: z.enum(["git-baseline", "workspace-overlay", "drop", "memory", "external"]),
  contentDigest: identifier.optional(),
  gitObjectId: gitObjectId.optional(),
  required: z.boolean(),
}).strict();

export const sessionCapsuleSchema = z.object({
  sessionCapsuleId: identifier,
  sessionKey: z.string().min(1).max(2048),
  harnessRevisionId: identifier,
  harness: z.object({
    namespace: z.string().min(1).max(1024),
    logicalPath: z.string().min(1).max(4096),
  }).strict(),
  workspace: z.object({
    workspaceId: identifier,
    capsuleRevisionId: identifier,
    baseCommit: gitObjectId.optional(),
  }).strict(),
  drops: z.array(z.object({ dropId: identifier, revisionId: identifier }).strict()).max(1_000),
  memories: z.array(z.object({
    memoryId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    revisionId: identifier,
  }).strict()).max(128).refine((pins) => new Set(pins.map((pin) => pin.memoryId)).size === pins.length,
    "memory pins must be unique").optional(),
  dependencies: z.array(dependencyReferenceSchema).max(100_000),
  createdAt: z.iso.datetime(),
  createdByDeviceId: identifier,
}).strict();

export type DependencyReference = z.infer<typeof dependencyReferenceSchema>;
export type SessionCapsuleV1 = z.infer<typeof sessionCapsuleSchema>;

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  vaultId: identifier,
  revisionId: identifier,
  parentRevisionIds: z.array(identifier).max(32),
  createdAt: z.iso.datetime(),
  createdByDeviceId: identifier,
  operationId: identifier,
  entries: z.array(manifestEntrySchema).max(100_000),
  tombstones: z.array(tombstoneSchema).max(100_000),
  conflicts: z.array(conflictSchema).max(100_000),
  sessionCapsules: z.array(sessionCapsuleSchema).max(100_000).optional(),
}).strict();

export type VaultManifestV1 = z.infer<typeof manifestSchema>;

export const commitRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  operationId: identifier,
  baseRevisionId: identifier.nullable(),
  revisionId: identifier,
  manifestObjectId: identifier,
  requiredObjectIds: z.array(identifier).max(10_000),
}).strict();

export type CommitRequest = z.infer<typeof commitRequestSchema>;

export const pathClaimSchema = z.object({
  pathId: identifier,
  mutation: z.enum(["add", "update", "delete"]),
}).strict();

export const namespaceUpdateSchema = z.object({
  namespace: identifier,
  keyEpoch: z.number().int().positive().safe().optional(),
  baseNamespaceRevisionId: identifier.nullable(),
  namespaceRevisionId: identifier,
  manifestObjectId: identifier,
  requiredObjectIds: z.array(identifier).max(10_000),
  retainedVaultRevisionIds: z.array(identifier).max(10_000).optional(),
  mode: z.enum(["replace", "append"]),
  pathClaims: z.array(pathClaimSchema).max(100_000),
}).strict().superRefine((update, context) => {
  const pathIds = new Set<string>();
  for (const [index, claim] of update.pathClaims.entries()) {
    if (pathIds.has(claim.pathId)) context.addIssue({ code: "custom", message: "duplicate path claim", path: ["pathClaims", index, "pathId"] });
    pathIds.add(claim.pathId);
    if (update.mode === "append" && claim.mutation !== "add") {
      context.addIssue({ code: "custom", message: "append updates may only add paths", path: ["pathClaims", index, "mutation"] });
    }
  }
  const retainedRevisionIds = new Set<string>();
  for (const [index, revisionId] of (update.retainedVaultRevisionIds ?? []).entries()) {
    if (retainedRevisionIds.has(revisionId)) {
      context.addIssue({ code: "custom", message: "duplicate retained vault revision", path: ["retainedVaultRevisionIds", index] });
    }
    retainedRevisionIds.add(revisionId);
  }
});

export const scopedCommitRequestSchema = z.object({
  protocolVersion: z.literal(SCOPED_PROTOCOL_VERSION),
  operationId: identifier,
  vaultRevisionId: identifier,
  updates: z.array(namespaceUpdateSchema).min(1).max(1_000),
}).strict().superRefine((request, context) => {
  const namespaces = new Set<string>();
  for (const [index, update] of request.updates.entries()) {
    if (namespaces.has(update.namespace)) context.addIssue({ code: "custom", message: "duplicate namespace update", path: ["updates", index, "namespace"] });
    namespaces.add(update.namespace);
  }
});

export type PathClaim = z.infer<typeof pathClaimSchema>;
export type NamespaceUpdate = z.infer<typeof namespaceUpdateSchema>;
export type ScopedCommitRequest = z.infer<typeof scopedCommitRequestSchema>;

export const namespaceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  vaultId: identifier,
  namespace: identifier,
  keyEpoch: z.number().int().positive().safe().optional(),
  namespaceRevisionId: identifier,
  parentNamespaceRevisionIds: z.array(identifier).max(32),
  createdAt: z.iso.datetime(),
  createdByDeviceId: identifier,
  operationId: identifier,
  mode: z.enum(["snapshot", "delta"]),
  entries: z.array(manifestEntrySchema).max(100_000),
  tombstones: z.array(tombstoneSchema).max(100_000),
  conflicts: z.array(conflictSchema).max(100_000),
  sessionCapsules: z.array(sessionCapsuleSchema).max(100_000).optional(),
  pathClaims: z.array(pathClaimSchema).max(100_000),
}).strict().superRefine((manifest, context) => {
  const logicalPaths = new Set<string>();
  for (const [collection, values] of [
    ["entries", manifest.entries],
    ["tombstones", manifest.tombstones],
    ["conflicts", manifest.conflicts],
  ] as const) {
    for (const [index, value] of values.entries()) {
      if (value.namespace !== manifest.namespace) {
        context.addIssue({ code: "custom", message: "content must match manifest namespace", path: [collection, index, "namespace"] });
      }
      const identity = value.logicalPath;
      if (logicalPaths.has(identity)) {
        context.addIssue({ code: "custom", message: "duplicate logical path", path: [collection, index, "logicalPath"] });
      }
      logicalPaths.add(identity);
    }
  }
  const pathIds = new Set<string>();
  for (const [index, claim] of manifest.pathClaims.entries()) {
    if (pathIds.has(claim.pathId)) context.addIssue({ code: "custom", message: "duplicate path claim", path: ["pathClaims", index, "pathId"] });
    pathIds.add(claim.pathId);
    if (manifest.mode === "delta" && claim.mutation !== "add") {
      context.addIssue({ code: "custom", message: "delta manifests may only add paths", path: ["pathClaims", index, "mutation"] });
    }
  }
});

export type NamespaceManifestV1 = z.infer<typeof namespaceManifestSchema>;

export type ProtocolErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "IDEMPOTENCY_CONFLICT"
  | "STALE_BASE"
  | "APPEND_VIOLATION"
  | "KEY_EPOCH_CONFLICT"
  | "KEY_RECIPIENT_MISMATCH"
  | "KEY_ENVELOPE_UNAVAILABLE"
  | "GC_BUSY"
  | "OBJECT_MISSING"
  | "UNSUPPORTED_PROTOCOL";

export interface PublicProtocolError {
  code: ProtocolErrorCode;
  message: string;
  status: number;
}

export function protocolError(
  code: ProtocolErrorCode,
  message: string,
  status: number,
  _cause?: unknown,
): PublicProtocolError {
  return { code, message, status };
}
