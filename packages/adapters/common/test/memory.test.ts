import { describe, expect, it } from "vitest";
import { memoryLogicalPath, memoryNativePath, validateMemorySet } from "../src/memory.js";

describe("reviewed native memory text (AD-MEM-002)", () => {
  it("preserves logical identity for Unicode Markdown and excludes non-memory state", () => {
    for (const path of ["MEMORY.md", "memory_summary.md", "topics/café.md", "rollout_summaries/2026-note.md"]) expect(memoryNativePath(memoryLogicalPath(path))).toBe(path);
    for (const path of ["", "/outside.md", "../escape.md", "a/../b.md", "a\\b.md", ".secret.md", "auth.json", "state.sqlite", "credentials.md", "a//b.md", "a\0b.md", "a/".repeat(17) + "b.md"]) {
      expect(() => memoryLogicalPath(path)).toThrow(); expect(memoryNativePath(`portable-memory/v1/${path}`)).toBeUndefined();
    }
    expect(memoryNativePath("portable-memory/v2/MEMORY.md")).toBeUndefined();
  });
  it("validates bounded UTF-8 bytes without rewriting Markdown or loading prose references", () => {
    const bytes = new TextEncoder().encode("---\ntype: project\n---\nSee [topic](topic.md) and https://example.invalid\n");
    const original = bytes.slice(); validateMemorySet(new Map([["MEMORY.md", bytes]])); expect(bytes).toEqual(original);
    for (const files of [new Map([["MEMORY.md", Uint8Array.of(255)]]), new Map([["MEMORY.md", Uint8Array.of(0)]]),
      new Map([["secret.json", bytes]]), new Map([["large.md", new Uint8Array(1024 * 1024 + 1)]]),
      new Map(Array.from({ length: 257 }, (_, index) => [`${index}.md`, new Uint8Array()] as const)),
      new Map(Array.from({ length: 9 }, (_, index) => [`${index}.md`, new Uint8Array(1024 * 1024).fill(97)] as const)),
    ]) expect(() => validateMemorySet(files)).toThrow("native memory format is unsupported or exceeds its limits");
  });
});
