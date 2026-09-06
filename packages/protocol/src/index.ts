import { z } from "zod";

export const PROTOCOL_VERSION = "1.0" as const;

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

export const manifestEntrySchema = z.object({
  namespace: z.string().min(1).max(1024),
  logicalPath: z.string().min(1).max(4096),
  entryType: z.enum(["file", "workspace-capsule", "workspace-blob"]).default("file"),
  workspacePath: z.string().min(1).max(4096).optional(),
  workspaceLayer: z.enum(["index", "worktree"]).optional(),
  fileMode: z.number().int().nonnegative().max(0o160000).optional(),
  objectIds: z.array(identifier).max(10_000),
  totalSize: z.number().int().nonnegative().safe(),
  contentDigest: identifier,
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
  source: z.enum(["git-baseline", "workspace-overlay", "drop", "external"]),
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

export type ProtocolErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "IDEMPOTENCY_CONFLICT"
  | "STALE_BASE"
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
