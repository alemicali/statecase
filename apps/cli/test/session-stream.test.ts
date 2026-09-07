import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectPortableSessionActivity, localizePortableSession, stagePortableSession } from "../src/session-stream.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("streamed session staging (AD-CX-008, PERF-003)", () => {
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
