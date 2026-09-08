import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";

export default defineConfig({
  test: {
    // These suites also run Git/esbuild/child Node VMs. Leave capacity for
    // those children without raising timeouts or skipping correctness tests.
    maxWorkers: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
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
