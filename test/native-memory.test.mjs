import { describe, expect, it } from "vitest";
import { assertClaudeMemoryContext } from "../scripts/uat/native-memory.mjs";

describe("fresh native memory evidence (AD-MEM-008)", () => {
  const expected = { prompt: "Run the synthetic task.", required: ["index-canary"], forbidden: ["other-project", "topic-canary"] };
  const body = () => ({ system: [{ type: "text", text: "native system" }], messages: [
    { role: "user", content: [{ type: "text", text: "<system-reminder>index-canary</system-reminder>" }, { type: "text", text: expected.prompt }] },
  ] });
  it("accepts fresh injected context in system or user text, with an independent prompt", () => {
    expect(() => assertClaudeMemoryContext(body(), expected)).not.toThrow();
    expect(() => assertClaudeMemoryContext({ system: "index-canary", messages: [{ role: "user", content: expected.prompt }] }, expected)).not.toThrow();
    expect(() => assertClaudeMemoryContext({ messages: [{ role: "user", content: expected.prompt }] }, { ...expected, required: [] })).not.toThrow();
  });
  it("rejects markers found only in tools, metadata, or a submitted prompt", () => {
    for (const extra of [{ tools: [{ description: "index-canary" }] }, { metadata: "index-canary" }]) {
      expect(() => assertClaudeMemoryContext({ ...extra, messages: [{ role: "user", content: expected.prompt }] }, expected)).toThrow("native memory context mismatch");
    }
    expect(() => assertClaudeMemoryContext(body(), { ...expected, prompt: "index-canary" })).toThrow();
    expect(() => assertClaudeMemoryContext(body(), { ...expected, prompt: "different prompt" })).toThrow();
  });
  it("rejects assistant history and tool results even when the marker is also injected", () => {
    for (const message of [
      { role: "assistant", content: "index-canary" },
      { role: "user", content: [{ type: "tool_result", content: "index-canary" }] },
      { role: "user", content: [{ type: "tool_use", input: { marker: "index-canary" } }] },
    ]) expect(() => assertClaudeMemoryContext({ ...body(), messages: [...body().messages, message] }, expected)).toThrow();
  });
  it("rejects cross-project recall and eager topic content without exposing request data", () => {
    for (const marker of expected.forbidden) {
      try { assertClaudeMemoryContext({ ...body(), system: `index-canary ${marker}` }, expected); throw new Error("accepted invalid request"); }
      catch (error) { expect(error.code).toBe("NATIVE_MEMORY_MISMATCH"); expect(error.message).toBe("native memory context mismatch"); }
    }
  });
  it("fails closed for malformed requests and ambiguous evidence definitions", () => {
    for (const invalid of [null, {}, { messages: [] }, { messages: [{}] }, { messages: [{ role: "user", content: null }] }]) {
      expect(() => assertClaudeMemoryContext(invalid, expected)).toThrow();
    }
    for (const invalid of [{ ...expected, required: [""] }, { ...expected, forbidden: ["index-canary"] }, { ...expected, prompt: "" }]) {
      expect(() => assertClaudeMemoryContext(body(), invalid)).toThrow();
    }
  });
});
