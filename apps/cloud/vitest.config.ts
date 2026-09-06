import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const directory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: join(directory, "wrangler.jsonc") },
      miniflare: {
        bindings: {
          BETTER_AUTH_SECRET: "worker-test-secret-that-is-at-least-32-characters",
          BETTER_AUTH_URL: "http://localhost:8787",
          STATECASE_ALLOWED_EMAILS: "runtime@statecase.test,approval@statecase.test,capability@statecase.test",
          TEST_MIGRATIONS: await readD1Migrations(join(directory, "migrations")),
        },
      },
    })),
  ],
  test: {
    include: [join(directory, "worker-test/**/*.test.ts")],
    setupFiles: [join(directory, "worker-test/apply-migrations.ts")],
    testTimeout: 30_000,
  },
});
