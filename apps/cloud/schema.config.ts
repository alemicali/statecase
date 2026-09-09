import { DatabaseSync } from "node:sqlite";

import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization } from "better-auth/plugins";

// Schema-generation only. Runtime auth is configured in src/auth.ts with D1.
export const auth = betterAuth({
  baseURL: "http://localhost:8787",
  database: new DatabaseSync("/tmp/statecase-better-auth-schema.db"),
  secret: "schema-generation-only-not-a-runtime-secret",
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
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
