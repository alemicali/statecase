import { describe, expect, it } from "vitest";
import { createMemoryReferenceRewriter, MemoryReferenceError, type SessionMemoryRoot } from "../src/session-memory-paths.js";

describe("typed memory references (AD-MEM-011)", () => {
  const roots: SessionMemoryRoot[] = [{ id: "recall", path: "/fixture/memory", workspaceId: "ws_a" }];
  const portable = () => {
    const rewrite = createMemoryReferenceRewriter(roots, "portable", "ws_a");
    rewrite({ type: "session_meta", cwd: "/fixture/project" });
    return rewrite;
  };
  const native = () => createMemoryReferenceRewriter([{ ...roots[0]!, path: "/target/memory" }], "native", "ws_a");
  const call = (path: string) => ({ type: "tool_use", name: "Read", input: { file_path: path } });
  it.each(["\n", "\r\n"])("round trips raw patch headers and never rewrites authored hunks (%j)", (eol) => {
    const make = (root: string) => ["*** Begin Patch", `*** Update File: ${root}/topic.md`,
      `*** Move to: ${root}/renamed.md`, "@@ /fixture/memory/context.md",
      "-/fixture/memory/old.md", "+statecase://memory/recall/authored.md",
      " *** Delete File: /fixture/memory/context.md", "*** End of File",
      `*** Add File: ${root}/new.md`, "+*** Add File: /fixture/memory/literal.md",
      `*** Delete File: ${root}/deleted.md`, "*** End Patch", ""].join(eol);
    for (const path of ["/fixture/memory", "../memory"]) {
      const source = { type: "custom_tool_call", name: "apply_patch", input: make(path) };
      const transformed = portable()(source);
      expect(transformed).toEqual({ ...source, input: make("statecase://memory/recall") });
      expect(native()(transformed)).toEqual({ ...source, input: make("/target/memory") });
      const sourceTarget = createMemoryReferenceRewriter([{ ...roots[0]!, path: "/target/memory" }], "portable", "ws_a");
      expect(sourceTarget(native()(transformed))).toEqual(transformed);
    }
    const unrelated = { type: "custom_tool_call", name: "apply_patch", input: make("/outside") };
    expect(portable()(unrelated)).toBe(unrelated);
    expect(native()(unrelated)).toBe(unrelated);
  });
  it("refuses unresolved patch identity, missing cwd, unsafe paths and malformed relative patches", () => {
    const patch = (path: string) => ({ type: "custom_tool_call", name: "apply_patch", input: `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch` });
    for (const path of ["statecase://memory/unknown/topic.md", "statecase://memory/recall/../topic.md"]) {
      expect(() => native()(patch(path))).toThrow(MemoryReferenceError);
    }
    expect(() => createMemoryReferenceRewriter([], "native")(patch("statecase://memory/recall/topic.md"))).toThrow();
    expect(() => createMemoryReferenceRewriter(roots, "native", "wrong")(patch("statecase://memory/recall/topic.md"))).toThrow();
    expect(() => createMemoryReferenceRewriter(roots, "portable", "ws_a")(patch("../memory/topic.md"))).toThrow();
    expect(() => portable()(patch("../memory/sub/../topic.md"))).toThrow();
    const malformed = { ...patch("../memory/topic.md"), input: "*** Begin Patch\n*** Add File: ../memory/topic.md\ninvalid\n*** End Patch" };
    expect(() => portable()(malformed)).toThrow(MemoryReferenceError);
    expect(createMemoryReferenceRewriter([], "portable")(malformed)).toBe(malformed);
    expect(native()(malformed)).toBe(malformed);
    expect(() => native()({ ...malformed, input: malformed.input.replace("../memory", "statecase://memory/recall") })).toThrow();
    expect(() => createMemoryReferenceRewriter([{ id: "recall", path: "/target\nunsafe" }], "native")(patch("statecase://memory/recall/topic.md"))).toThrow(MemoryReferenceError);
    const nested = { type: "function_call", function: { name: "apply_patch", arguments: patch("../memory/topic.md").input } };
    expect(portable()(nested)).toEqual({ ...nested, function: { ...nested.function, arguments: patch("statecase://memory/recall/topic.md").input } });
    expect(native()(portable()(nested))).toEqual({ ...nested, function: { ...nested.function, arguments: patch("/target/memory/topic.md").input } });
  });
  it("tracks only explicit native cwd observations and never guesses from process cwd or prose", () => {
    const rewrite = createMemoryReferenceRewriter(roots, "portable", "ws_a");
    expect(() => rewrite(call("../memory/topic.md"))).toThrow(MemoryReferenceError);
    rewrite({ type: "message", cwd: "/fixture/project", content: "session_meta cwd=/fixture/project" });
    expect(() => rewrite(call("../memory/topic.md"))).toThrow();
    rewrite({ type: "user", cwd: "/fixture/project", message: { role: "user", content: "Synthetic prompt" } });
    expect(rewrite(call("../memory/topic.md"))).toEqual(call("statecase://memory/recall/topic.md"));
    rewrite({ type: "turn_context", payload: { working_directory: "/fixture/project/nested" } });
    expect(rewrite(call("../../memory/topic.md"))).toEqual(call("statecase://memory/recall/topic.md"));
    expect(rewrite(call("../memory/topic.md"))).toEqual(call("../memory/topic.md"));
    rewrite({ type: "assistant", cwd: "/fixture/memory", message: { role: "assistant", content: [] } });
    expect(rewrite(call("./topic.md"))).toEqual(call("statecase://memory/recall/topic.md"));
    expect(rewrite(call("."))).toEqual(call("statecase://memory/recall"));
    expect(rewrite(call("./"))).toEqual(call("statecase://memory/recall"));
    expect(createMemoryReferenceRewriter([], "portable")(call("relative.md"))).toEqual(call("relative.md"));
  });
  it("rejects invalid explicit cwd and noncanonical memory-relative paths", () => {
    for (const cwd of [null, false, 42, "relative", "/bad\u0000cwd", "/bad\ncwd", "/" + "x".repeat(4096)]) {
      expect(() => portable()({ type: "session_meta", payload: { cwd } })).toThrow();
    }
    for (const path of ["../memory/nested/../topic.md", "../memory//topic.md", "../memory/topic.md/", "../memory/auth.json", "../memory/topic\\name.md"]) {
      expect(() => portable()(call(path))).toThrow();
    }
    const rewrite = portable();
    for (const observation of [{ type: "cwd" }, { type: "assistant", cwd: "/wrong", message: { role: "user" } }, null]) rewrite(observation);
    expect(rewrite(call("../memory/topic.md"))).toEqual(call("statecase://memory/recall/topic.md"));
    rewrite({ type: "cwd_changed", working_directory: "/fixture/project/nested" });
    expect(rewrite(call("../../memory/topic.md"))).toEqual(call("statecase://memory/recall/topic.md"));
  });
  it.each(["", "/topic.md", "/nested", "/nested/topic.md", "/mémoire notes.md"])("round trips safe files and directory references: %s", (suffix) => {
    const transformed = portable()(call(`/fixture/memory${suffix}`));
    expect(transformed).toEqual(call(`statecase://memory/recall${suffix}`));
    expect(native()(transformed)).toEqual(call(`/target/memory${suffix}`));
  });
  it("keeps root-prefix lookalikes, relative paths and user/artifact/tool-output content unchanged", () => {
    const records = [null, 4, "literal", call("relative.md"), call("/fixture/memory-other/topic.md"),
      { role: "user", content: [call("/fixture/memory/topic.md")] },
      ...["text", "input_text", "output_text", "tool_result", "function_call_output", "custom_tool_call_output"].map((type) => ({ type, content: [call("/fixture/memory/topic.md")] })),
      { metadata: call("/fixture/memory/topic.md"), text: "/fixture/memory/topic.md" },
      { type: "tool_use", name: "Write", input: { file_path: "/outside/file.md", content: { file_path: "/fixture/memory/topic.md" }, old_string: "/fixture/memory/topic.md", new_string: "statecase://memory/recall/topic.md" } },
    ];
    expect(portable()(records)).toEqual(records);
  });
  it("handles reviewed JSON argument and function envelopes without mutating input or unrelated bytes", () => {
    for (const input of [
      { type: "function_call", name: "read_file", arguments: JSON.stringify({ path: "/fixture/memory/topic.md", format: "text" }) },
      { type: "tool_call", function: { name: "Read", arguments: JSON.stringify({ filename: "/fixture/memory/topic.md" }) } },
      { type: "tool_request", tool: "MoveFile", parameters: { from_path: "/fixture/memory/topic.md", to_path: "/fixture/memory/other.md" } },
      { type: "tool_call", tool_name: "Edit", input: { file_path: "/fixture/memory/topic.md", old_string: "/fixture/memory/old.md" } },
    ]) {
      const before = structuredClone(input), transformed = portable()({ payload: { message: { role: "assistant", content: [input] } } });
      expect(input).toEqual(before); expect(JSON.stringify(transformed)).toContain("statecase://memory/recall/");
      expect(JSON.stringify(native()(transformed))).toContain("/target/memory/");
    }
    const whitespace = { type: "function_call", name: "Read", arguments: '{ "path": "relative.md" }' };
    expect(portable()(whitespace)).toBe(whitespace);
  });
  it.each(["../escape.md", "topic.md/../other.md", "/topic.md", "topic\\file.md", "auth.json", "credentials/key.md", "%2e%2e/file.md", "topic.md?query", "topic.md#fragment", ".hidden.md", "topic\u0000.md"])("rejects unsafe native/portable suffixes without exposing the value: %s", (suffix) => {
    for (const [rewrite, path] of [[portable(), `/fixture/memory/${suffix}`], [native(), `statecase://memory/recall/${suffix}`]] as const) {
      expect(() => rewrite(call(path))).toThrow(MemoryReferenceError);
      try { rewrite(call(path)); } catch (error) { expect((error as Error).message).toBe("session memory reference cannot be safely mapped"); }
    }
  });
  it("requires an exact granted ID and workspace ownership, including source-side references", () => {
    for (const rootsOnTarget of [[], [{ ...roots[0]!, id: "different" }], [{ ...roots[0]!, workspaceId: "ws_b" }]]) {
      expect(() => createMemoryReferenceRewriter(rootsOnTarget, "native", "ws_a")(call("statecase://memory/recall/topic.md"))).toThrow(MemoryReferenceError);
    }
    expect(() => createMemoryReferenceRewriter(roots, "portable", "ws_b")(call("/fixture/memory/topic.md"))).toThrow();
    expect(() => createMemoryReferenceRewriter(roots, "portable")(call("/fixture/memory/topic.md"))).toThrow();
    expect(() => native()(call("statecase://memory/recall/"))).toThrow();
    expect(() => portable()(call("statecase://memory/recall/topic.md"))).toThrow();
    expect(createMemoryReferenceRewriter([{ id: "global", path: "/global" }], "portable")(call("/global/topic.md")))
      .toEqual(call("statecase://memory/global/topic.md"));
  });
  it("rejects ambiguous root bindings and malformed identifiers before rewriting", () => {
    for (const bad of [[...roots, ...roots], [{ ...roots[0]!, id: "bad/id" }], [{ ...roots[0]!, path: "relative" }], Array.from({ length: 129 }, (_, i) => ({ id: `id${i}`, path: `/fixture/${i}` }))]) {
      expect(() => createMemoryReferenceRewriter(bad, "portable", "ws_a")).toThrow();
    }
    const ambiguous = createMemoryReferenceRewriter([...roots, { id: "nested", path: "/fixture/memory/nested" }], "portable", "ws_a");
    expect(() => ambiguous(call("/fixture/memory/nested/topic.md"))).toThrow();
  });
  it("fails closed for unsupported tool schemas that would require a memory-path change", () => {
    for (const name of ["unknown_tool", null]) {
      expect(() => portable()({ ...call("/fixture/memory/topic.md"), name })).toThrow();
    }
    for (const input of ["malformed /fixture/memory/topic.md", "*** Begin Patch\n*** Update File: /fixture/memory/topic.md\nunsupported\n*** End Patch"])
      expect(() => portable()({ type: "tool_call", name: "apply_patch", input })).toThrow();
    expect(() => portable()({ type: "custom_tool_call", name: "unknown_patch", input: "*** Begin Patch\n*** Update File: /fixture/memory/topic.md\n*** End Patch" })).toThrow();
    expect(() => native()({ type: "function_call", name: "Read", arguments: "bad statecase://memory/recall/topic.md" })).toThrow();
    for (const input of [undefined, null, 1, "unrelated opaque input", "null", "[1,2]", { file_path: 1 }]) {
      const record = { type: "tool_call", name: "Read", input };
      expect(portable()(record)).toBe(record);
    }
  });
  it("bounds event nesting and node counts", () => {
    let nested: unknown = call("/fixture/memory/topic.md");
    for (let i = 0; i < 65; i++) nested = { payload: nested };
    expect(() => portable()(nested)).toThrow();
    expect(() => portable()(Array(100_001).fill(null))).toThrow();
  });
});
