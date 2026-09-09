import { describe, expect, it } from "vitest";
import { assertNativeInstructions } from "../scripts/uat/native-instructions.mjs";

describe("native instruction request evidence (AD-CTX-007)", () => {
  it.each(["codex", "claude"])("requires all %s context markers and excludes fallback markers", (kind) => {
    const expected = { required: ["global-marker", "included-marker"], forbidden: ["fallback-marker"] };
    const context = kind === "codex" ? { instructions: "global-marker", input: [{ content: "included-marker" }] }
      : { system: [{ text: "global-marker" }], messages: [{ role: "user", content: "included-marker" }] };
    expect(() => assertNativeInstructions(kind, context, expected)).not.toThrow();
    for (const body of [{}, null, { tools: [{ description: "global-marker included-marker" }] }, { ...context, instructions: "fallback-marker", system: "fallback-marker" }]) {
      expect(() => assertNativeInstructions(kind, body, expected)).toThrow("native instruction context mismatch");
    }
    expect(() => assertNativeInstructions(kind, context, { ...expected, required: [...expected.required, "missing"] })).toThrow();
  });
  it("rejects unsupported harnesses without exposing context", () => {
    expect(() => assertNativeInstructions("unknown", { secret: "private-canary" }, { required: [], forbidden: [] })).toThrow("native instruction context mismatch");
  });
});
