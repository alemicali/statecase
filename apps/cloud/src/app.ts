import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";

import { commitRequestSchema, PROTOCOL_VERSION, type CommitRequest, type ProtocolErrorCode } from "@statecase/protocol";
import type { CommitResult, VaultHead } from "@statecase/sync-core";

import { DEVICE_HTML, UI_CSS, UI_JAVASCRIPT } from "./ui.js";

const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface Principal {
  accountId: string;
  deviceId: string;
  scopes: string[];
}

export interface AuthService {
  handle(request: Request): Promise<Response> | Response;
  authenticate(request: Request): Promise<Principal | null>;
}

export interface ObjectStore {
  putIfAbsent(
    vaultId: string,
    objectId: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<{ created: boolean; size: number }>;
  get(vaultId: string, objectId: string): Promise<Uint8Array | ReadableStream<Uint8Array> | null>;
  exists(vaultId: string, objectId: string): Promise<boolean>;
}

export interface Coordinator {
  head(): Promise<VaultHead | null>;
  commit(request: CommitRequest): Promise<CommitResult>;
}

export interface VaultSummary {
  id: string;
  name?: string;
  role: "owner" | "writer" | "reader" | "append" | null;
}

export interface ControlPlane {
  registerDevice(
    principal: Principal,
    input: { name: string; publicSigningKey?: string; publicExchangeKey?: string },
  ): Promise<{ accountId: string; deviceId: string; name: string }>;
  createVault(principal: Principal, input: { name: string }): Promise<VaultSummary>;
  listVaults(principal: Principal): Promise<VaultSummary[]>;
  joinVault(principal: Principal, vaultId: string): Promise<VaultSummary>;
}

export interface CloudServices {
  auth: AuthService;
  objects: ObjectStore;
  authorizeVault(principal: Principal, vaultId: string, action: "read" | "write"): Promise<boolean>;
  coordinator(vaultId: string): Coordinator;
  control: ControlPlane;
}

type AppEnvironment = { Variables: { principal: Principal } };

export function createCloudApp(services: CloudServices): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();
  app.use("*", secureHeaders());

  app.get("/health", (context) => context.json({ protocolVersion: PROTOCOL_VERSION, service: "statecase", status: "ok" }));
  app.get("/", (context) => context.html(DEVICE_HTML));
  app.get("/login", (context) => context.html(DEVICE_HTML));
  app.get("/device", (context) => context.html(DEVICE_HTML));
  app.get("/ui.css", (context) => context.body(UI_CSS, 200, { "content-type": "text/css; charset=utf-8" }));
  app.get("/ui.js", (context) => context.body(UI_JAVASCRIPT, 200, { "content-type": "text/javascript; charset=utf-8" }));
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

  app.post("/v1/devices/current", async (context) => {
    const body = await parseBody(context, z.object({
      name: z.string().trim().min(1).max(120),
      publicSigningKey: z.string().min(1).max(4096).optional(),
      publicExchangeKey: z.string().min(1).max(4096).optional(),
    }).strict());
    if (!body.success) return body.response;
    return context.json(await services.control.registerDevice(context.get("principal"), body.data));
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
    const body = context.req.raw.body ?? new Blob([]).stream();
    const result = await services.objects.putIfAbsent(vaultId, objectId, limited(body, MAX_OBJECT_BYTES));
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
  action: "read" | "write",
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

function limited(source: ReadableStream<Uint8Array>, maximum: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maximum) throw new BodyTooLarge();
      controller.enqueue(chunk);
    },
  }));
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
