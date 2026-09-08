import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { LocalConfig } from "../src/config.js";
import { memoryMappings } from "../src/memory-bindings.js";

const fixture = (): LocalConfig => ({ version: 1, apiUrl: "https://fixture.invalid", applied: {},
  mappings: [{ id: "claude", namespace: "harness:claude:default", kind: "claude", mode: "two-way", name: "Claude", path: resolve("synthetic/claude") },
    { id: "codex", namespace: "harness:codex:default", kind: "codex", mode: "two-way", name: "Codex", path: resolve("synthetic/codex") }],
  workspaces: [{ id: "ws_project", path: resolve("synthetic/project") }],
});
const binding = () => ({ id: "project_memory", kind: "claude-project" as const, harnessNamespace: "harness:claude:default", workspaceId: "ws_project",
  path: resolve("synthetic/claude/projects/local-project/memory"), mode: "two-way" as const });

describe("explicit memory binding identity (AD-MEM-001)", () => {
  it("does not select memory implicitly and derives the same identity at different local paths", () => {
    const first = fixture(); expect(memoryMappings(first)).toEqual([]);
    first.memories = [binding()]; const second = structuredClone(first); second.memories![0]!.path = resolve("other-machine/native-memory");
    const [a] = memoryMappings(first), [b] = memoryMappings(second);
    expect(a).toMatchObject({ id: "memory_project_memory", namespace: "memory:project_memory", kind: "drop", memory: { kind: "claude-project", harnessNamespace: "harness:claude:default", workspaceId: "ws_project" } });
    expect(b!.namespace).toBe(a!.namespace); expect(b!.path).not.toBe(a!.path);
    expect(first.mappings).toHaveLength(2); expect(first.applied).toEqual({});
  });
  it("distinguishes explicit global Codex memory from repository-scoped Claude memory", () => {
    const config = fixture(); config.memories = [{ id: "global_recall", kind: "codex-global", harnessNamespace: "harness:codex:default", path: resolve("synthetic/codex/memories"), mode: "consume", name: "Recall" }];
    expect(memoryMappings(config)[0]).toMatchObject({ namespace: "memory:global_recall", name: "Recall", mode: "consume", memory: { kind: "codex-global" } });
    expect(memoryMappings(config)[0]!.memory).not.toHaveProperty("workspaceId");
  });
  it.each([
    { id: "../escape" }, { id: "ambiguous:identity" }, { id: "" }, { id: undefined }, { id: 123 }, { id: "a".repeat(220) },
    { kind: "unknown" }, { mode: "unknown" }, { path: "relative" }, { path: "/" },
    { path: "bad\0path" }, { path: "/" + "a".repeat(4100) }, { name: 123 }, { name: "a".repeat(257) }, { harnessNamespace: "harness:missing:default" },
    { workspaceId: undefined }, { workspaceId: "missing" }, { harnessNamespace: "harness:codex:default" },
    { kind: "codex-global", harnessNamespace: "harness:codex:default" },
  ])("rejects malformed or mis-scoped bindings %# without leaking local paths", (changes) => {
    const config = fixture(); config.memories = [{ ...binding(), ...changes } as ReturnType<typeof binding>];
    expect(() => memoryMappings(config)).toThrow("memory binding is invalid or has conflicting ownership");
  });
  it("rejects duplicate namespace identities and overlapping memory or Drop ownership", () => {
    for (const other of [binding(), { ...binding(), id: "other" }, { ...binding(), id: "other", path: resolve(binding().path, "nested") }]) {
      const config = fixture(); config.memories = [binding(), other]; expect(() => memoryMappings(config)).toThrow();
    }
    for (const dropPath of [binding().path, resolve(binding().path, "nested"), resolve(binding().path, "..")]) {
      const config = fixture(); config.memories = [binding()];
      config.mappings.push({ id: "drop", kind: "drop", namespace: "drop:other", path: dropPath, mode: "consume", name: "Drop" });
      expect(() => memoryMappings(config)).toThrow();
    }
    const config = fixture(); config.memories = [binding()];
    config.mappings.push({ id: "collision", kind: "drop", namespace: "memory:project_memory", path: resolve("unrelated"), mode: "consume", name: "Drop" });
    expect(() => memoryMappings(config)).toThrow();
  });
  it("rejects roots that own harness configuration or workspace files", () => {
    for (const root of [resolve("synthetic"), resolve("synthetic/claude"), resolve("synthetic/project"), resolve("synthetic/project/nested")]) {
      const config = fixture(); config.memories = [{ ...binding(), path: root }]; expect(() => memoryMappings(config)).toThrow();
    }
  });
  it("rejects malformed collections and ambiguous harness/workspace owners", () => {
    for (const memories of [null, {}, "invalid", [null], Array.from({ length: 129 }, binding)]) {
      const config = fixture(); config.memories = memories as unknown as LocalConfig["memories"]; expect(() => memoryMappings(config)).toThrow();
    }
    const config = fixture(); config.memories = [binding()]; config.mappings.push({ ...config.mappings[0]!, id: "duplicate" });
    expect(() => memoryMappings(config)).toThrow(); config.mappings.pop(); config.workspaces.push({ ...config.workspaces[0]! });
    expect(() => memoryMappings(config)).toThrow();
  });
});
