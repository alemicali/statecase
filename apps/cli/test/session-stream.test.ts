import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectPortableSessionActivity, localizePortableSession, stagePortableSession } from "../src/session-stream.js";
import * as diskSpace from "../src/disk-space.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("streamed session staging (AD-CX-008, PERF-003)", () => {
  it("resolves relative memory references using each native cwd and records their dependency activity (AD-MEM-011)", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-memory-relative-session-")); temporary.push(root);
    const workspace = join(root, "project"), memory = join(root, "memory"), source = join(root, "source.jsonl");
    const records = [
      { type: "session_meta", payload: { cwd: workspace } },
      { type: "tool_call", name: "read_file", arguments: { path: "../memory/topic.md" } },
      { type: "turn_context", payload: { cwd: join(workspace, "nested") } },
      { type: "assistant", cwd: join(workspace, "nested"), message: { role: "assistant", content: [
        { type: "tool_use", name: "Write", input: { file_path: "../../memory/topic.md", content: "../../memory/unchanged prose.md" } },
      ] } },
    ];
    await writeFile(source, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const staged = await stagePortableSession(source, [{ id: "ws_a", path: workspace }], { memories: [{ id: "recall", path: memory, workspaceId: "ws_a" }] });
    try {
      const lines = (await readFile(staged!.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(lines[1].arguments.path).toBe("statecase://memory/recall/topic.md");
      expect(lines[3].message.content[0].input).toEqual({ file_path: "statecase://memory/recall/topic.md", content: "../../memory/unchanged prose.md" });
      expect(staged!.activity).toEqual(expect.arrayContaining([
        { path: join(memory, "topic.md"), access: "read", source: "native-event" },
        { path: join(memory, "topic.md"), access: "write", source: "native-event" },
      ]));
    } finally { await staged?.dispose(); }
  });
  it("maps memory tool references by identity while preserving prose and written content (AD-MEM-011)", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-session-memory-path-")); temporary.push(root);
    const workspace = join(root, "project"), memory = join(root, "source-memory"), targetMemory = join(root, "target-memory");
    const source = join(root, "source.jsonl"), destination = join(root, "target.jsonl");
    const nativePath = join(memory, "topic.md"), portablePath = "statecase://memory/recall/topic.md";
    const records = [
      { type: "session_meta", cwd: workspace },
      { type: "assistant", message: { role: "assistant", content: [
        { type: "text", text: nativePath },
        { type: "tool_use", name: "Write", input: { file_path: nativePath, content: nativePath } },
      ] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: { path: nativePath } }] } },
    ];
    await writeFile(source, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const staged = await stagePortableSession(source, [{ id: "ws_test", path: workspace }], { memories: [{ id: "recall", path: memory, workspaceId: "ws_test" }] });
    try {
      const portable = (await readFile(staged!.path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
      expect(portable[1].message.content[1].input).toEqual({ file_path: portablePath, content: nativePath });
      expect(portable[1].message.content[0].text).toBe(nativePath); expect(portable[2]).toEqual(records[2]);
      const options = { memories: [{ id: "recall", path: targetMemory, workspaceId: "ws_test" }] };
      await localizePortableSession(staged!.path, destination, "ws_test", workspace, options);
      const localized = (await readFile(destination, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
      expect(localized[1].message.content[1].input).toEqual({ file_path: join(targetMemory, "topic.md"), content: nativePath });
      expect(localized[2]).toEqual(records[2]);
      const restaged = await stagePortableSession(destination, [{ id: "ws_test", path: workspace }], options);
      try { expect(await readFile(restaged!.path, "utf8")).toBe(await readFile(staged!.path, "utf8")); }
      finally { await restaged?.dispose(); }
      expect(await inspectPortableSessionActivity(staged!.path, "ws_test", workspace, options)).toContainEqual({ path: join(targetMemory, "topic.md"), access: "write", source: "native-event" });
      await expect(localizePortableSession(staged!.path, join(root, "missing.jsonl"), "ws_test", workspace)).rejects.toMatchObject({ code: "MEMORY_REFERENCE_UNRESOLVED" });
    } finally { await staged?.dispose(); }
  });
  it("maps an unbound global memory session and removes plaintext staging after a rejected binding (AD-MEM-011)", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-memory-global-session-")); temporary.push(root);
    const source = join(root, "source.jsonl"), memory = join(root, "memory");
    await writeFile(source, JSON.stringify({ type: "tool_call", name: "read_file", arguments: { path: join(memory, "topic.md") } }) + "\n");
    const staged = await stagePortableSession(source, [], { memories: [{ id: "global", path: memory }] });
    try {
      expect(staged?.workspaceId).toBeUndefined();
      const destination = join(root, "destination.jsonl");
      await localizePortableSession(staged!.path, destination, undefined, undefined, { memories: [{ id: "global", path: join(root, "target") }] });
      expect(JSON.parse(await readFile(destination, "utf8")).arguments.path).toBe(join(root, "target", "topic.md"));
    } finally { await staged?.dispose(); }
    const created = vi.spyOn(diskSpace, "createStagingDirectory");
    try {
      await expect(stagePortableSession(source, [], { memories: [{ id: "project", path: memory, workspaceId: "wrong-project" }] })).rejects.toMatchObject({ code: "MEMORY_REFERENCE_UNRESOLVED" });
      const ownedRoot = await created.mock.results[0]!.value;
      await expect(access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { created.mockRestore(); }
  });
  it("does not turn native record types or prose into paths when sync runs inside the workspace (AD-CX-007)", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-session-cwd-"));
    temporary.push(root);
    const workspace = join(root, "project");
    await mkdir(workspace);
    const source = join(root, "source.jsonl");
    const records = [
      { type: "session_meta", payload: { cwd: workspace, model: "fixture-model" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [
        { type: "output_text", text: "Keep this text unchanged." },
      ] } },
      { type: "tool_call", name: "read_file", arguments: { path: "relative.txt", absolute: join(workspace, "absolute.txt") } },
    ];
    await writeFile(source, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(workspace);
    try {
      const staged = await stagePortableSession(source, [{ id: "ws_test", path: workspace }]);
      try {
        const portable = (await readFile(staged!.path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
        expect(portable[0]).toEqual({ type: "session_meta", payload: { cwd: "statecase://workspace/ws_test", model: "fixture-model" } });
        expect(portable[1]).toEqual(records[1]);
        expect(portable[2]).toEqual({ type: "tool_call", name: "read_file", arguments: {
          path: "relative.txt", absolute: "statecase://workspace/ws_test/absolute.txt",
        } });
      } finally { await staged?.dispose(); }
    } finally { cwd.mockRestore(); }
  });

  it("captures only complete records, portabilizes paths, and resolves relative activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-session-stage-test-"));
    temporary.push(root);
    const workspace = join(root, "project");
    const source = join(root, "session.jsonl");
    await mkdir(workspace);
    await writeFile(source, [
      JSON.stringify({ type: "session_meta", payload: { cwd: workspace } }),
      JSON.stringify({ type: "tool_call", name: "read_file", arguments: { path: "notes.md" } }),
      '{"partial":true',
    ].join("\n"));

    const staged = await stagePortableSession(source, [{ id: "ws_test", path: workspace }]);
    expect(staged).toBeDefined();
    expect(await readFile(staged!.path, "utf8")).toBe([
      JSON.stringify({ type: "session_meta", payload: { cwd: "statecase://workspace/ws_test" } }),
      JSON.stringify({ type: "tool_call", name: "read_file", arguments: { path: "notes.md" } }),
      "",
    ].join("\n"));
    expect(staged!.activity).toContainEqual({ path: join(workspace, "notes.md"), access: "read", source: "native-event" });
    const stagedPath = staged!.path;
    await staged!.dispose();
    await expect(access(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when one complete or incomplete record exceeds the configured memory bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-session-stage-limit-"));
    temporary.push(root);
    const source = join(root, "session.jsonl");
    await writeFile(source, `${JSON.stringify({ payload: "x".repeat(128) })}\n`);
    await expect(stagePortableSession(source, [], { maxRecordBytes: 32 })).rejects.toThrow("exceeds 32 bytes");
    await writeFile(source, "x".repeat(33));
    await expect(stagePortableSession(source, [], { maxRecordBytes: 32 })).rejects.toThrow("exceeds 32 bytes");
  });

  it("rejects malformed complete records but returns no staging for a wholly incomplete live file", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-session-stage-format-"));
    temporary.push(root);
    const source = join(root, "session.jsonl");
    await writeFile(source, "not json\n");
    await expect(stagePortableSession(source, [])).rejects.toMatchObject({ code: "MALFORMED_COMPLETE_RECORD" });
    await writeFile(source, '{"live":true');
    await expect(stagePortableSession(source, [])).resolves.toBeUndefined();
    await expect(stagePortableSession(source, [], { maxRecordBytes: 0 })).rejects.toThrow("positive");
  });

  it("localizes a staged portable session record by record and rejects an incomplete remote tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-session-localize-"));
    temporary.push(root);
    const source = join(root, "portable.jsonl");
    const destination = join(root, "native.jsonl");
    const workspace = join(root, "different", "project");
    await writeFile(source, `${JSON.stringify({ cwd: "statecase://workspace/ws_test", path: "statecase://workspace/ws_test/src/a.ts" })}\n`);

    await expect(localizePortableSession(source, destination, "ws_test", workspace)).resolves.toBeGreaterThan(0);
    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({ cwd: workspace, path: join(workspace, "src", "a.ts") });

    const incomplete = join(root, "incomplete.jsonl");
    await writeFile(incomplete, '{"cwd":"statecase://workspace/ws_test"}');
    await expect(localizePortableSession(incomplete, join(root, "rejected.jsonl"), "ws_test", workspace)).rejects.toThrow("incomplete");
    await expect(localizePortableSession(source, join(root, "invalid-limit.jsonl"), "ws_test", workspace, { maxRecordBytes: 0 }))
      .rejects.toThrow("positive");
  });

  it.each([
    "statecase://workspace/ws_test/../outside",
    "statecase://workspace/ws_test/src//outside",
    "statecase://workspace/ws_test/src\\outside",
  ])("rejects an unsafe portable workspace URI before writing outside the mapped root: %s", async (unsafePath) => {
    const root = await mkdtemp(join(tmpdir(), "statecase-session-localize-traversal-"));
    temporary.push(root);
    const source = join(root, "portable.jsonl");
    await writeFile(source, `${JSON.stringify({ path: unsafePath })}\n`);

    await expect(localizePortableSession(source, join(root, "native.jsonl"), "ws_test", join(root, "workspace")))
      .rejects.toThrow("unsafe workspace path");
  });

  it("stages unbound CRLF records unchanged and handles arrays without inventing a workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-session-unbound-"));
    temporary.push(root);
    const source = join(root, "session.jsonl");
    const record = [{ path: "/outside/a" }, "literal"];
    await writeFile(source, `${JSON.stringify(record)}\r\n`);

    const staged = await stagePortableSession(source, [{ id: "ws_elsewhere", path: join(root, "elsewhere") }]);
    expect(staged?.workspaceId).toBeUndefined();
    expect(await readFile(staged!.path, "utf8")).toBe(`${JSON.stringify(record)}\r\n`);
    await staged!.dispose();
  });

  it("rejects a non-file session source", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-session-directory-"));
    temporary.push(root);
    await expect(stagePortableSession(root, [])).rejects.toThrow("regular file");
  });

  it("extracts localized activity from a merged portable session without retaining its records", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-session-inspect-"));
    temporary.push(root);
    const source = join(root, "portable.jsonl");
    const workspace = join(root, "workspace");
    await writeFile(source, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "statecase://workspace/ws_test" } }),
      JSON.stringify({ type: "tool_call", name: "read_file", arguments: { path: "remote.md" } }),
      JSON.stringify({ type: "tool_call", name: "write_file", arguments: { path: "statecase://workspace/ws_test/local.md" } }),
      "",
    ].join("\n"));

    await expect(inspectPortableSessionActivity(source, "ws_test", workspace)).resolves.toEqual(expect.arrayContaining([
      { path: join(workspace, "remote.md"), access: "read", source: "native-event" },
      { path: join(workspace, "local.md"), access: "write", source: "native-event" },
    ]));

    await writeFile(source, `${JSON.stringify({
      type: "tool_call",
      name: "read_file",
      arguments: { path: "statecase://workspace/ws_test/direct.md" },
    })}\n`);
    await expect(inspectPortableSessionActivity(source, "ws_test", workspace)).resolves.toEqual([
      { path: join(workspace, "direct.md"), access: "read", source: "native-event" },
    ]);
    await expect(inspectPortableSessionActivity(source, "ws_test", workspace, { maxRecordBytes: 0 }))
      .rejects.toThrow("positive");
    await writeFile(source, "{\"incomplete\":true}");
    await expect(inspectPortableSessionActivity(source, "ws_test", workspace)).rejects.toThrow("incomplete");
  });
});
