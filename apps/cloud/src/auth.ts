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
      const session = await instance().api.getSession({ headers: request.headers });
      if (!session) return null;
      return {
        accountId: session.user.id,
        deviceId: session.session.id,
        scopes: ["sync"],
      };
    },
  };
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
