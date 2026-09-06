import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";

import {
  commitRequestSchema,
  PROTOCOL_VERSION,
  SCOPED_PROTOCOL_VERSION,
  scopedCommitRequestSchema,
  type CommitRequest,
  type ProtocolErrorCode,
  type ScopedCommitRequest,
} from "@statecase/protocol";
import type {
  CommitResult,
  CreateSnapshotResult,
  NamespaceHead,
  NamespaceRevision,
  ScopedCommitResult,
  ScopedVaultHead,
  ScopedVaultRevision,
  VaultHead,
  VaultRevision,
  VaultSnapshot,
} from "@statecase/sync-core";

import { DEVICE_HTML, UI_CSS, UI_JAVASCRIPT } from "./ui.js";

const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface Principal {
  accountId: string;
  sessionId: string;
  deviceId: string;
  scopes: string[];
  credentialType?: "device" | "capability";
  capability?: {
    id: string;
    vaultId: string;
    namespaces: string[];
    actions: Array<"read" | "append">;
  };
}

export interface CapabilitySummary {
  id: string;
  vaultId: string;
  namespaces: string[];
  actions: Array<"read" | "append">;
  expiresAt: number;
  redeemedAt?: number;
  revokedAt?: number;
  createdAt: number;
}

export interface CapabilityService {
  create(principal: Principal, input: {
    id: string;
    vaultId: string;
    tokenHash: string;
    namespaces: string[];
    actions: Array<"read" | "append">;
    expiresAt: number;
    keyEnvelope: string;
  }): Promise<CapabilitySummary>;
  list(principal: Principal): Promise<CapabilitySummary[]>;
  revoke(principal: Principal, capabilityId: string): Promise<void>;
  redeem(token: string): Promise<{ accessToken: string; expiresAt: number; vaultId: string; namespaces: string[]; actions: Array<"read" | "append">; keyEnvelope: string } | null>;
}

export interface AuthService {
  handle(request: Request): Promise<Response> | Response;
  authenticate(request: Request): Promise<Principal | null>;
}

export interface ObjectStore {
  putIfAbsent(
    vaultId: string,
    objectId: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    namespace?: string,
  ): Promise<{ created: boolean; size: number }>;
  get(vaultId: string, objectId: string, namespace?: string): Promise<Uint8Array | ReadableStream<Uint8Array> | null>;
  exists(vaultId: string, objectId: string, namespace?: string): Promise<boolean>;
}

export interface Coordinator {
  head(): Promise<VaultHead | null>;
  revision(revisionId: string): Promise<VaultRevision | null>;
  commit(request: CommitRequest): Promise<CommitResult>;
  listSnapshots(): Promise<VaultSnapshot[]>;
  createSnapshot(input: { id: string; name: string; createdAt: number }): Promise<CreateSnapshotResult>;
  deleteSnapshot(snapshotId: string): Promise<boolean>;
  namespaceHeads(allowedNamespaces?: ReadonlySet<string>): Promise<NamespaceHead[]>;
  namespaceRevision(namespace: string, revisionId: string): Promise<NamespaceRevision | null>;
  scopedHead(): Promise<ScopedVaultHead | null>;
  commitNamespaces(request: ScopedCommitRequest): Promise<ScopedCommitResult>;
  scopedRevision(revisionId: string): Promise<ScopedVaultRevision | null>;
}

export interface VaultSummary {
  id: string;
  name?: string;
  role: "owner" | "writer" | "reader" | "append" | null;
}

export interface DeviceSummary {
  id: string;
  name: string;
  status: "active" | "revoked";
  createdAt?: number;
  lastSeenAt?: number;
}

export interface ControlPlane {
  registerDevice(
    principal: Principal,
    input: { id: string; name: string; publicSigningKey?: string; publicExchangeKey?: string },
  ): Promise<{ accountId: string; deviceId: string; name: string }>;
  listDevices(principal: Principal): Promise<DeviceSummary[]>;
  revokeDevice(principal: Principal, deviceId: string): Promise<void>;
  createVault(principal: Principal, input: { name: string }): Promise<VaultSummary>;
  listVaults(principal: Principal): Promise<VaultSummary[]>;
  joinVault(principal: Principal, vaultId: string): Promise<VaultSummary>;
}

export interface CloudServices {
  auth: AuthService;
  objects: ObjectStore;
  authorizeVault(principal: Principal, vaultId: string, action: "read" | "write" | "admin"): Promise<boolean>;
  authorizeNamespace(principal: Principal, vaultId: string, namespace: string, action: "read" | "append" | "write"): Promise<boolean>;
  coordinator(vaultId: string): Coordinator;
  control: ControlPlane;
  capabilities: CapabilityService;
}

type AppEnvironment = { Variables: { principal: Principal } };

export function createCloudApp(services: CloudServices): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();
  app.use("*", secureHeaders());

  app.get("/health", (context) => context.json({ protocolVersion: SCOPED_PROTOCOL_VERSION, legacyProtocolVersion: PROTOCOL_VERSION, service: "statecase", status: "ok" }));
  app.get("/", (context) => context.html(DEVICE_HTML));
  app.get("/login", (context) => context.html(DEVICE_HTML));
  app.get("/device", (context) => context.html(DEVICE_HTML));
  app.get("/ui.css", (context) => context.body(UI_CSS, 200, { "content-type": "text/css; charset=utf-8" }));
  app.get("/ui.js", (context) => context.body(UI_JAVASCRIPT, 200, { "content-type": "text/javascript; charset=utf-8" }));
  app.post("/api/bootstrap/redeem", async (context) => {
    context.header("cache-control", "no-store");
    context.header("pragma", "no-cache");
    const body = await parseBody(context, z.object({ token: z.string().min(40).max(512) }).strict());
    if (!body.success) return body.response;
    const redeemed = await services.capabilities.redeem(body.data.token);
    return redeemed
      ? context.json(redeemed)
      : jsonError(context, "AUTH_REQUIRED", "bootstrap capability is invalid, expired, revoked, or already used", 401);
  });
  app.all("/api/auth/*", (context) => services.auth.handle(context.req.raw));

  app.use("/v1/*", async (context, next) => {
    const principal = await services.auth.authenticate(context.req.raw);
    if (!principal) return jsonError(context, "AUTH_REQUIRED", "authentication required", 401);
    context.set("principal", principal);
    await next();
  });

  app.get("/v1/vaults/:vaultId/head", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    if (!(await allowed(services, context, vaultId, "read"))) return notFound(context);
    const head = await services.coordinator(vaultId).head();
    return context.json(head ?? { revisionId: null, manifestObjectId: null });
  });

  app.get("/v1/vaults/:vaultId/namespaces", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    const principal = context.get("principal");
    if (principal.capability?.vaultId !== vaultId && !(await allowed(services, context, vaultId, "read"))) return notFound(context);
    const heads = await services.coordinator(vaultId).namespaceHeads();
    const decisions = await Promise.all(heads.map((head) =>
      services.authorizeNamespace(context.get("principal"), vaultId, head.namespace, "read")));
    const visible = heads.filter((_head, index) => decisions[index]);
    return context.json({ revisionId: (await services.coordinator(vaultId).scopedHead())?.revisionId ?? null, namespaces: visible });
  });

  app.get("/v1/vaults/:vaultId/namespaces/:namespace/revisions/:revisionId", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    const namespace = requireIdentifier(context.req.param("namespace"));
    const revisionId = requireIdentifier(context.req.param("revisionId"));
    if (!(await services.authorizeNamespace(context.get("principal"), vaultId, namespace, "read"))) return notFound(context);
    const revision = await services.coordinator(vaultId).namespaceRevision(namespace, revisionId);
    return revision ? context.json(revision) : notFound(context);
  });

  app.get("/v1/vaults/:vaultId/scoped-revisions/:revisionId", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    const revisionId = requireIdentifier(context.req.param("revisionId"));
    const principal = context.get("principal");
    if (principal.capability?.vaultId !== vaultId && !(await allowed(services, context, vaultId, "read"))) return notFound(context);
    const revision = await services.coordinator(vaultId).scopedRevision(revisionId);
    if (!revision) return notFound(context);
    const decisions = await Promise.all(revision.namespaces.map((head) =>
      services.authorizeNamespace(principal, vaultId, head.namespace, "read")));
    return context.json({ ...revision, namespaces: revision.namespaces.filter((_head, index) => decisions[index]) });
  });

  app.get("/v1/vaults/:vaultId/revisions/:revisionId", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    const revisionId = requireIdentifier(context.req.param("revisionId"));
    if (!(await allowed(services, context, vaultId, "read"))) return notFound(context);
    const revision = await services.coordinator(vaultId).revision(revisionId);
    return revision ? context.json(revision) : notFound(context);
  });

  app.get("/v1/vaults/:vaultId/snapshots", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    if (!(await allowed(services, context, vaultId, "read"))) return notFound(context);
    return context.json({ snapshots: await services.coordinator(vaultId).listSnapshots() });
  });

  app.post("/v1/vaults/:vaultId/snapshots", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    if (!(await allowed(services, context, vaultId, "write"))) return notFound(context);
    const body = await parseBody(context, z.object({ id: z.string().regex(identifier), name: z.string().trim().min(1).max(120) }).strict());
    if (!body.success) return body.response;
    const result = await services.coordinator(vaultId).createSnapshot({
      id: body.data.id,
      name: body.data.name,
      createdAt: Date.now(),
    });
    if (result.outcome === "no-head") return jsonError(context, "INVALID_REQUEST", "vault has no revision to snapshot", 409);
    if (result.outcome === "id-conflict") return jsonError(context, "IDEMPOTENCY_CONFLICT", "snapshot ID was already used", 409);
    return context.json(result.snapshot, 201);
  });

  app.delete("/v1/vaults/:vaultId/snapshots/:snapshotId", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    const snapshotId = requireIdentifier(context.req.param("snapshotId"));
    if (!(await allowed(services, context, vaultId, "admin"))) return notFound(context);
    if (!(await services.coordinator(vaultId).deleteSnapshot(snapshotId))) return notFound(context);
    return context.body(null, 204);
  });

  app.post("/v1/devices/current", async (context) => {
    const body = await parseBody(context, z.object({
      id: z.string().regex(identifier),
      name: z.string().trim().min(1).max(120),
      publicSigningKey: z.string().min(1).max(4096).optional(),
      publicExchangeKey: z.string().min(1).max(4096).optional(),
    }).strict());
    if (!body.success) return body.response;
    return context.json(await services.control.registerDevice(context.get("principal"), body.data));
  });

  app.get("/v1/devices", async (context) => {
    return context.json({ devices: await services.control.listDevices(context.get("principal")) });
  });

  app.delete("/v1/devices/:deviceId", async (context) => {
    const deviceId = requireIdentifier(context.req.param("deviceId"));
    await services.control.revokeDevice(context.get("principal"), deviceId);
    return context.body(null, 204);
  });

  app.post("/v1/tokens", async (context) => {
    if (context.get("principal").capability) return notFound(context);
    const body = await parseBody(context, z.object({
      id: z.string().regex(identifier),
      vaultId: z.string().regex(identifier),
      tokenHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      namespaces: z.array(z.string().regex(identifier)).min(1).max(64),
      actions: z.array(z.enum(["read", "append"])).min(1).max(2),
      expiresAt: z.number().int().positive(),
      keyEnvelope: z.string().min(1).max(128 * 1024),
    }).strict().superRefine((input, refinement) => {
      if (new Set(input.namespaces).size !== input.namespaces.length) refinement.addIssue({ code: "custom", message: "duplicate namespace" });
      if (new Set(input.actions).size !== input.actions.length) refinement.addIssue({ code: "custom", message: "duplicate action" });
      if (input.actions.includes("append") && !input.actions.includes("read")) {
        refinement.addIssue({ code: "custom", message: "append capabilities must also allow read" });
      }
      if (input.namespaces.some((namespace) => namespace === "secrets" || namespace.startsWith("secrets:"))) {
        refinement.addIssue({ code: "custom", message: "ephemeral capabilities cannot access secrets" });
      }
      const now = Date.now();
      if (input.expiresAt <= now || input.expiresAt > now + 24 * 60 * 60 * 1000) {
        refinement.addIssue({ code: "custom", message: "capability expiry must be within 24 hours" });
      }
    }));
    if (!body.success) return body.response;
    if (!(await allowed(services, context, body.data.vaultId, "admin"))) return notFound(context);
    return context.json(await services.capabilities.create(context.get("principal"), body.data), 201);
  });

  app.get("/v1/tokens", async (context) => {
    if (context.get("principal").capability) return notFound(context);
    return context.json({ tokens: await services.capabilities.list(context.get("principal")) });
  });

  app.delete("/v1/tokens/:tokenId", async (context) => {
    if (context.get("principal").capability) return notFound(context);
    const tokenId = requireIdentifier(context.req.param("tokenId"));
    await services.capabilities.revoke(context.get("principal"), tokenId);
    return context.body(null, 204);
  });

  app.get("/v1/vaults", async (context) => {
    return context.json({ vaults: await services.control.listVaults(context.get("principal")) });
  });

  app.post("/v1/vaults", async (context) => {
    const body = await parseBody(context, z.object({ name: z.string().trim().min(1).max(120) }).strict());
    if (!body.success) return body.response;
    return context.json(await services.control.createVault(context.get("principal"), body.data), 201);
  });

  app.post("/v1/vaults/:vaultId/join", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    return context.json(await services.control.joinVault(context.get("principal"), vaultId));
  });

  app.put("/v1/vaults/:vaultId/objects/:objectId", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    const objectId = requireIdentifier(context.req.param("objectId"));
    if (!(await allowed(services, context, vaultId, "write"))) return notFound(context);
    const declaredLength = context.req.header("content-length");
    if (declaredLength !== undefined && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_OBJECT_BYTES)) {
      return jsonError(context, "INVALID_REQUEST", "encrypted object exceeds the upload limit", 413);
    }
    const body = await readLimited(context.req.raw.body ?? new Blob([]).stream(), MAX_OBJECT_BYTES);
    const result = await services.objects.putIfAbsent(vaultId, objectId, body);
    return context.json({ created: result.created, objectId, size: result.size }, result.created ? 201 : 200);
  });

  app.get("/v1/vaults/:vaultId/objects/:objectId", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    const objectId = requireIdentifier(context.req.param("objectId"));
    if (!(await allowed(services, context, vaultId, "read"))) return notFound(context);
    const value = await services.objects.get(vaultId, objectId);
    if (!value) return notFound(context);
    return new Response(value, {
      headers: {
        "cache-control": "private, max-age=31536000, immutable",
        "content-type": "application/octet-stream",
      },
    });
  });

  app.put("/v1/vaults/:vaultId/namespaces/:namespace/objects/:objectId", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    const namespace = requireIdentifier(context.req.param("namespace"));
    const objectId = requireIdentifier(context.req.param("objectId"));
    if (!(await services.authorizeNamespace(context.get("principal"), vaultId, namespace, "write")) &&
        !(await services.authorizeNamespace(context.get("principal"), vaultId, namespace, "append"))) return notFound(context);
    const declaredLength = context.req.header("content-length");
    if (declaredLength !== undefined && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_OBJECT_BYTES)) {
      return jsonError(context, "INVALID_REQUEST", "encrypted object exceeds the upload limit", 413);
    }
    const body = await readLimited(context.req.raw.body ?? new Blob([]).stream(), MAX_OBJECT_BYTES);
    const result = await services.objects.putIfAbsent(vaultId, objectId, body, namespace);
    return context.json({ created: result.created, objectId, size: result.size }, result.created ? 201 : 200);
  });

  app.get("/v1/vaults/:vaultId/namespaces/:namespace/objects/:objectId", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    const namespace = requireIdentifier(context.req.param("namespace"));
    const objectId = requireIdentifier(context.req.param("objectId"));
    if (!(await services.authorizeNamespace(context.get("principal"), vaultId, namespace, "read"))) return notFound(context);
    const value = await services.objects.get(vaultId, objectId, namespace);
    if (!value) return notFound(context);
    return new Response(value, {
      headers: { "cache-control": "private, max-age=31536000, immutable", "content-type": "application/octet-stream" },
    });
  });

  app.post("/v1/vaults/:vaultId/commits", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    if (!(await allowed(services, context, vaultId, "write"))) return notFound(context);
    let parsed: ReturnType<typeof commitRequestSchema.safeParse>;
    try {
      parsed = commitRequestSchema.safeParse(await context.req.json());
    } catch {
      return jsonError(context, "INVALID_REQUEST", "invalid commit request", 400);
    }
    if (!parsed.success) return jsonError(context, "INVALID_REQUEST", "invalid commit request", 400);
    const request = parsed.data;
    const required = new Set([request.manifestObjectId, ...request.requiredObjectIds]);
    const availability = await Promise.all([...required].map((objectId) => services.objects.exists(vaultId, objectId)));
    if (availability.some((exists) => !exists)) {
      return jsonError(context, "OBJECT_MISSING", "one or more encrypted objects are missing", 409);
    }

    const result = await services.coordinator(vaultId).commit(request);
    if (result.outcome === "idempotency-conflict") {
      return jsonError(context, "IDEMPOTENCY_CONFLICT", "operation ID was already used for another payload", 409);
    }
    if (result.outcome === "stale-base") {
      return context.json(
        { error: { code: "STALE_BASE", currentRevisionId: result.currentRevisionId, message: "vault head advanced" } },
        409,
      );
    }
    return context.json(result);
  });

  app.post("/v1/vaults/:vaultId/namespace-commits", async (context) => {
    const vaultId = requireIdentifier(context.req.param("vaultId"));
    const body = await parseBody(context, scopedCommitRequestSchema);
    if (!body.success) return body.response;
    for (const update of body.data.updates) {
      const action = update.mode === "append" ? "append" as const : "write" as const;
      if (!(await services.authorizeNamespace(context.get("principal"), vaultId, update.namespace, action))) return notFound(context);
      const required = new Set([update.manifestObjectId, ...update.requiredObjectIds]);
      const availability = await Promise.all([...required].map((objectId) => services.objects.exists(vaultId, objectId, update.namespace)));
      if (availability.some((exists) => !exists)) {
        return jsonError(context, "OBJECT_MISSING", "one or more encrypted namespace objects are missing", 409);
      }
    }
    const result = await services.coordinator(vaultId).commitNamespaces(body.data);
    if (result.outcome === "idempotency-conflict") return jsonError(context, "IDEMPOTENCY_CONFLICT", "operation ID was already used for another payload", 409);
    if (result.outcome === "stale-namespace") {
      return context.json({ error: { code: "STALE_BASE", namespaces: result.namespaces, message: "one or more namespace heads advanced" } }, 409);
    }
    if (result.outcome === "append-violation") {
      return context.json({ error: { code: "APPEND_VIOLATION", namespace: result.namespace, pathIds: result.pathIds, message: "append-only path identity already exists" } }, 409);
    }
    return context.json(result);
  });

  app.notFound((context) => notFound(context));
  app.onError((error, context) => {
    if (error instanceof BodyTooLarge) {
      return jsonError(context, "INVALID_REQUEST", "encrypted object exceeds the upload limit", 413);
    }
    if (error instanceof InvalidIdentifier) return jsonError(context, "INVALID_REQUEST", "invalid resource identifier", 400);
    if (error instanceof ControlPlaneError) {
      if (error.reason === "not-found") return notFound(context);
      return jsonError(context, "INVALID_REQUEST", "register this device before managing vaults", 409);
    }
    return jsonError(context, "INVALID_REQUEST", "request failed safely", 500);
  });
  return app;
}

async function allowed(
  services: CloudServices,
  context: Context<AppEnvironment>,
  vaultId: string,
  action: "read" | "write" | "admin",
): Promise<boolean> {
  return services.authorizeVault(context.get("principal"), vaultId, action);
}

function requireIdentifier(value: string): string {
  if (!identifier.test(value)) throw new InvalidIdentifier();
  return value;
}

function notFound(context: Context<AppEnvironment>): Response {
  return jsonError(context, "NOT_FOUND", "resource not found", 404);
}

function jsonError(
  context: Context<AppEnvironment>,
  code: ProtocolErrorCode,
  message: string,
  status: 400 | 401 | 404 | 409 | 413 | 500,
): Response {
  return context.json({ error: { code, message } }, status);
}

async function readLimited(source: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      seen += item.value.byteLength;
      if (seen > maximum) {
        await reader.cancel();
        throw new BodyTooLarge();
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(seen);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class BodyTooLarge extends Error {}
class InvalidIdentifier extends Error {}

export class ControlPlaneError extends Error {
  constructor(readonly reason: "device-required" | "not-found") {
    super(reason);
  }
}

async function parseBody<T extends z.ZodType>(
  context: Context<AppEnvironment>,
  schema: T,
): Promise<{ success: true; data: z.output<T> } | { success: false; response: Response }> {
  try {
    const result = schema.safeParse(await context.req.json());
    if (result.success) return { success: true, data: result.data };
  } catch {
    // The public response below intentionally omits parser detail and request content.
  }
  return { success: false, response: jsonError(context, "INVALID_REQUEST", "invalid request body", 400) };
}
