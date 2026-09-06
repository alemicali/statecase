import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_ID, PROTOCOL_MAJOR } from "../packages/domain/src/index.js";

describe("standalone product identity", () => {
  it("IS-002: has a new protocol and product identity", () => {
    expect(PRODUCT_ID).toBe("statecase");
    expect(PROTOCOL_MAJOR).toBe(1);
  });

  it("IS-002: has no forbidden legacy dependency", async () => {
    const manifestPath = join(import.meta.dirname, "..", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const dependencyNames = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    });

    expect(dependencyNames).not.toContain("agentstash");
    expect(dependencyNames).not.toContain("clawstash");
    expect(dependencyNames).not.toContain("restic");
  });

  it("IS-003: uses only Statecase-owned environment variable names", async () => {
    const implementationPath = join(import.meta.dirname, "..", "docs", "IMPLEMENTATION_SPEC.md");
    const implementation = await readFile(implementationPath, "utf8");
    expect(implementation).not.toContain("AGENTSTASH_");
    expect(implementation).toContain("STATECASE_HOME");
  });
});
