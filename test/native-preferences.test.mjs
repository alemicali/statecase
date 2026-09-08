import { describe, expect, it } from "vitest";
import { assertNativePreferences } from "../scripts/uat/native-preferences.mjs";

describe("native effective-preference qualification assertions (AD-CFG-012)", () => {
  it.each(["codex", "claude"])("accepts only the expected actual model and effort for %s", (kind) => {
    const body = { model: "fixture-model", ...(kind === "codex" ? { reasoning: { effort: "low" } } : { output_config: { effort: "low" } }) };
    expect(() => assertNativePreferences(kind, body, { model: "fixture-model", effort: "low" })).not.toThrow();
    for (const invalid of [null, [], {}, { model: "fixture-model" }, { ...body, model: "private-canary" }, { ...body, reasoning: { effort: "high" }, output_config: { effort: "high" } }]) {
      expect(() => assertNativePreferences(kind, invalid, { model: "fixture-model", effort: "low" })).toThrow("native effective preferences mismatch");
      try { assertNativePreferences(kind, invalid, { model: "fixture-model", effort: "low" }); }
      catch (error) { expect(String(error)).not.toContain("private-canary"); }
    }
    expect(() => assertNativePreferences(kind, body, { model: "fixture-model", effort: "high" })).toThrow();
  });
  it("rejects unsupported harness identities", () => {
    expect(() => assertNativePreferences("unknown", { model: "fixture", output_config: { effort: "low" } }, { model: "fixture", effort: "low" })).toThrow();
  });
});
