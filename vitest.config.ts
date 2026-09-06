import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["apps/cloud/worker-test/**", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["apps/**/src/**/*.ts", "packages/**/src/**/*.ts"],
      // Entrypoint wiring is exercised by CLI integration and workerd suites;
      // keep the V8 gate focused on portable implementation modules.
      exclude: [
        "apps/cli/src/bin.ts",
        "apps/cli/src/runtime.ts",
        "apps/cloud/src/app.ts",
        "apps/cloud/src/auth.ts",
        "apps/cloud/src/bindings.ts",
        "apps/cloud/src/index.ts",
      ],
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
