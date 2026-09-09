import { describe, expect, it } from "vitest";
import { assertNativePreferences, summarizeNativeConfigChange, summarizeNativeProjectChange } from "../scripts/uat/native-preferences.mjs";

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
  it("reports only fixed config-change categories, never native keys or values", () => {
    expect(summarizeNativeConfigChange('model="fixture"\n', 'model = "fixture"\n')).toEqual({ kind: "formatting", fields: [], other: false });
    expect(summarizeNativeConfigChange('model="fixture"\n', 'model="secret-canary"\n[projects."private-path"]\ntrust_level="trusted"\n')).toEqual({ kind: "values", fields: ["model", "projects"], other: false });
    expect(summarizeNativeConfigChange('private_canary="secret"\n', 'private_canary="other-secret"\n')).toEqual({ kind: "values", fields: [], other: true });
    expect(summarizeNativeConfigChange('model="fixture"\n', 'model="fixture"\n')).toEqual({ kind: "unchanged", fields: [], other: false });
    for (const invalid of ["bad = [", "x".repeat(1024 * 1024 + 1), null]) {
      expect(summarizeNativeConfigChange("", invalid)).toEqual({ kind: "invalid", fields: [], other: false });
    }
  });
  it("categorizes project-local trust changes without exposing project identities", () => {
    expect(summarizeNativeProjectChange('', '[projects."/private-canary"]\ntrust_level="trusted"\n', { target: "/private-canary" }))
      .toEqual([{ scope: "target", kind: "added", trustBefore: "absent", trustAfter: "trusted", other: false }]);
    expect(summarizeNativeProjectChange('[projects."/private-canary"]\ntrust_level="trusted"\nsecret="canary"\n', '', {}))
      .toEqual([{ scope: "other", kind: "removed", trustBefore: "trusted", trustAfter: "absent", other: true }]);
    expect(summarizeNativeProjectChange('', 'projects="canary"', {})).toEqual([{ scope: "invalid" }]);
    expect(summarizeNativeProjectChange('', '[projects."/unknown"]\ntrust_level="canary"\n', {}))
      .toEqual([{ scope: "other", kind: "added", trustBefore: "absent", trustAfter: "other", other: false }]);
    expect(summarizeNativeProjectChange('', '', {})).toEqual([]);
  });
});
