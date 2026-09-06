import { describe, expect, it } from "vitest";

import { AdapterFormatError, extractActivityReferences, scanCompleteJsonl, sessionWorkingDirectory } from "../src/index.js";

describe("append-safe JSONL scan (AD-CX-003..005, AD-CL-003)", () => {
  it("parses complete records and preserves an incomplete tail", () => {
    const input = new TextEncoder().encode('{"id":1}\r\n{"id":2}\n{"id":');
    const result = scanCompleteJsonl(input);
    expect(result.records).toEqual([{ id: 1 }, { id: 2 }]);
    expect(new TextDecoder().decode(result.acceptedPrefix)).toBe('{"id":1}\r\n{"id":2}\n');
    expect(new TextDecoder().decode(result.deferredTail)).toBe('{"id":');
  });

  it("fails closed on malformed complete JSON rather than skipping it", () => {
    expect(() => scanCompleteJsonl(new TextEncoder().encode('{broken}\n'))).toThrowError(
      expect.objectContaining({ code: "MALFORMED_COMPLETE_RECORD" }),
    );
  });

  it("detects an accepted-prefix rewrite", () => {
    const first = scanCompleteJsonl(new TextEncoder().encode('{"id":1}\n'));
    expect(() =>
      scanCompleteJsonl(new TextEncoder().encode('{"id":9}\n'), {
        length: first.acceptedPrefix.byteLength,
        digest: first.acceptedDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "PREFIX_REWRITTEN" }));
  });

  it("accepts an unchanged prefix followed by appended records", () => {
    const firstBytes = new TextEncoder().encode('{"id":1}\n');
    const first = scanCompleteJsonl(firstBytes);
    const next = scanCompleteJsonl(new TextEncoder().encode('{"id":1}\n{"id":2}\n'), {
      length: first.acceptedPrefix.byteLength,
      digest: first.acceptedDigest,
    });
    expect(next.records).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("detects truncation and serializes only a safe error", () => {
    const error = new AdapterFormatError("PREFIX_REWRITTEN", "safe diagnostic");
    expect(error.toJSON()).toEqual({ code: "PREFIX_REWRITTEN", message: "safe diagnostic" });
    expect(() => scanCompleteJsonl(new Uint8Array(), { length: 1, digest: "x" })).toThrowError(
      expect.objectContaining({ code: "PREFIX_REWRITTEN" }),
    );
  });

  it("ignores blank complete records", () => {
    expect(scanCompleteJsonl(new TextEncoder().encode('\n\r\n{"id":1}\n')).records).toEqual([{ id: 1 }]);
  });
});

describe("structured harness activity extraction (WS-021..WS-024)", () => {
  it("extracts canonical absolute read, write, delete, and rename references from tool calls", () => {
    const records = [
      { type: "session_meta", payload: { cwd: "/work/project" } },
      { type: "tool_call", name: "read_file", arguments: { path: "src/read.ts" } },
      { type: "tool_use", tool: "write_file", input: { file_path: "/work/project/src/write.ts" } },
      { type: "tool_call", name: "delete_file", arguments: { path: "old.txt" } },
      { type: "tool_call", name: "rename_file", arguments: { from_path: "a.txt", to_path: "b.txt" } },
    ];
    expect(extractActivityReferences(records)).toEqual([
      { path: "/work/project/src/read.ts", access: "read", source: "native-event" },
      { path: "/work/project/src/write.ts", access: "write", source: "native-event" },
      { path: "/work/project/old.txt", access: "delete", source: "native-event" },
      { path: "/work/project/a.txt", access: "rename", source: "native-event" },
      { path: "/work/project/b.txt", access: "rename", source: "native-event" },
    ]);
  });

  it("ignores prompt prose and unsafe or ambiguous paths, then deduplicates repeated events", () => {
    const records = [
      { type: "session_meta", payload: { cwd: "/work/project" } },
      { role: "user", content: "please read /etc/passwd and src/fake.ts" },
      { type: "tool_call", name: "read_file", arguments: { path: "src/real.ts" } },
      { type: "tool_call", name: "read_file", arguments: { path: "src/real.ts" } },
      { type: "tool_call", name: "read_file", arguments: { path: "../escape.ts" } },
      { type: "tool_call", name: "shell", arguments: { command: "cat /etc/passwd" } },
    ];
    expect(extractActivityReferences(records)).toEqual([
      { path: "/work/project/src/real.ts", access: "read", source: "native-event" },
    ]);
  });

  it("tracks cwd changes and treats paths outside it as explicit absolute references", () => {
    const records = [
      { type: "session_meta", payload: { cwd: "/first" } },
      { type: "tool_call", name: "view", arguments: { file: "one.md" } },
      { type: "cwd_changed", cwd: "/second" },
      { type: "tool_call", name: "edit", arguments: { path: "/external/two.md" } },
    ];
    expect(extractActivityReferences(records)).toEqual([
      { path: "/first/one.md", access: "read", source: "native-event" },
      { path: "/external/two.md", access: "write", source: "native-event" },
    ]);
    expect(sessionWorkingDirectory(records)).toBe("/second");
    expect(sessionWorkingDirectory([null, { type: "message", cwd: "/ignored" }])).toBeUndefined();
  });

  it("handles nested provider variants and rejects malformed structured arguments fail-closed", () => {
    const records = [
      null,
      { type: 42, payload: { cwd: "/ignored" } },
      { type: "session_meta", payload: "invalid", cwd: "relative" },
      { type: "turn_context", working_directory: "/work" },
      [{ type: "function_call", function: { name: "create_file", arguments: JSON.stringify({ path: "new.txt" }) } }],
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "claude.md" } }] } },
      { wrapper: { type: "tool_request", tool_name: "search_files", parameters: { nested: [{ filename: "docs.md" }] } } },
      { type: "tool_use", tool: "remove_file", input: { target_path: "/tmp/remove.txt" } },
      { type: "function_call", function: { name: "read_file", arguments: "not-json" } },
      { type: "tool_call", name: "unknown_operation", arguments: { path: "/tmp/ignored" } },
      { type: "tool_call", name: "read_file", arguments: { path: "" } },
      { type: "tool_call", name: "read_file", arguments: { path: `bad\0path` } },
      { type: "tool_call", name: "read_file", arguments: { path: "x".repeat(4097) } },
    ];
    expect(extractActivityReferences(records)).toEqual([
      { path: "/work/new.txt", access: "create", source: "native-event" },
      { path: "/work/claude.md", access: "read", source: "native-event" },
      { path: "/work/docs.md", access: "read", source: "native-event" },
      { path: "/tmp/remove.txt", access: "delete", source: "native-event" },
    ]);
  });
});
