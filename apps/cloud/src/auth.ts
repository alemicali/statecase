import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization } from "better-auth/plugins";

import type { AuthService, Principal } from "./app.js";

export interface AuthEnvironment {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  STATECASE_ALLOWED_EMAILS: string;
}

export function createBetterAuthService(environment: AuthEnvironment): AuthService {
  let auth: ReturnType<typeof buildAuth> | undefined;
  const instance = (): ReturnType<typeof buildAuth> => auth ??= buildAuth(environment);

  return {
    handle: async (request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/sign-up/email")) {
        const input = await request.clone().json().catch(() => ({})) as { email?: unknown };
        if (typeof input.email !== "string" || !allowedEmail(environment.STATECASE_ALLOWED_EMAILS, input.email)) {
          return Response.json({ code: "SIGNUP_DISABLED", message: "account creation is not enabled for this email" }, { status: 403 });
        }
      }
      return instance().handler(request);
    },
    authenticate: async (request): Promise<Principal | null> => {
      const capability = await authenticateCapability(environment.DB, request);
      if (capability) return capability;
      const session = await instance().api.getSession({ headers: request.headers });
      if (!session) return null;
      const binding = await environment.DB.prepare(`
        SELECT ds.device_id
        FROM device_sessions AS ds
        JOIN devices AS d ON d.id = ds.device_id
        WHERE ds.session_id = ? AND ds.account_id = ? AND ds.revoked_at IS NULL
          AND d.account_id = ? AND d.status = 'active'
        LIMIT 1
      `).bind(session.session.id, session.user.id, session.user.id).first<{ device_id: string }>();
      return {
        accountId: session.user.id,
        sessionId: session.session.id,
        deviceId: binding?.device_id ?? session.session.id,
        scopes: ["sync"],
        credentialType: "device",
      };
    },
  };
}

async function authenticateCapability(database: D1Database, request: Request): Promise<Principal | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer stc_access_")) return null;
  const token = authorization.slice("Bearer ".length);
  const tokenHash = await sha256Base64Url(token);
  const now = Date.now();
  const row = await database.prepare(`
    SELECT cs.id AS session_id, cg.id AS capability_id, cg.account_id, cg.vault_id,
           cg.namespaces_json, cg.actions_json
    FROM capability_sessions AS cs
    JOIN capability_grants AS cg ON cg.id = cs.grant_id
    JOIN statecase_accounts AS sa ON sa.id = cg.account_id
    JOIN vaults AS v ON v.id = cg.vault_id AND v.account_id = cg.account_id
    WHERE cs.token_hash = ? AND cs.revoked_at IS NULL AND cs.expires_at > ?
      AND cg.revoked_at IS NULL AND cg.expires_at > ? AND cg.redeemed_at IS NOT NULL
      AND sa.status = 'active' AND v.status = 'active'
    LIMIT 1
  `).bind(tokenHash, now, now).first<{
    session_id: string;
    capability_id: string;
    account_id: string;
    vault_id: string;
    namespaces_json: string;
    actions_json: string;
  }>();
  if (!row) return null;
  const namespaces = parseStringArray(row.namespaces_json);
  const actions = parseStringArray(row.actions_json);
  if (actions.some((action) => action !== "read" && action !== "append")) return null;
  return {
    accountId: row.account_id,
    sessionId: row.session_id,
    deviceId: row.capability_id,
    scopes: actions,
    credentialType: "capability",
    capability: {
      id: row.capability_id,
      vaultId: row.vault_id,
      namespaces,
      actions: actions as Array<"read" | "append">,
    },
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function allowedEmail(configuration: string, email: string): boolean {
  if (configuration.trim() === "*") return true;
  const normalized = email.trim().toLowerCase();
  return configuration.split(",").some((candidate) => candidate.trim().toLowerCase() === normalized);
}

function buildAuth(environment: AuthEnvironment) {
  return betterAuth({
    appName: "Statecase",
    baseURL: environment.BETTER_AUTH_URL,
    database: environment.DB,
    secret: environment.BETTER_AUTH_SECRET,
    trustedOrigins: [environment.BETTER_AUTH_URL],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      requireEmailVerification: false,
    },
    plugins: [
      bearer(),
      deviceAuthorization({
        verificationUri: "/device",
        expiresIn: "10m",
        interval: "5s",
        validateClient: (clientId) => clientId === "statecase-cli",
      }),
    ],
  });
}
