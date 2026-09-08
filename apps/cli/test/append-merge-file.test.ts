import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isCompleteJsonlFileRecordSupersequence, mergeJsonlAppendFiles } from "../src/append-merge-file.js";
import { createMemoryReferenceRewriter } from "../src/session-memory-paths.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bounded-memory JSONL file append merge (SY-004, SY-005, PERF-003)", () => {
  it("compares reviewed memory projections once per record without hiding changes or incomplete tails (AD-MEM-011)", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-projected-supersequence-")); temporary.push(root);
    const localPath = join(root, "local.jsonl"), remotePath = join(root, "remote.jsonl");
    const metadata = { type: "session_meta", cwd: "/fixture/project" };
    const read = (path: string, content = "historical") => ({ type: "tool_call", name: "read_file", arguments: { path, content } });
    const local = [metadata, read("../memory/topic.md"), read("../memory/topic.md")];
    const remote = [metadata, { id: "remote-only" }, read("/fixture/memory/topic.md"), read("/fixture/memory/topic.md")];
    const encode = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await writeFile(localPath, encode(local)); await writeFile(remotePath, encode(remote));
    const projections = () => ({ local: createMemoryReferenceRewriter([{ id: "recall", path: "/fixture/memory" }], "portable"),
      remote: createMemoryReferenceRewriter([{ id: "recall", path: "/fixture/memory" }], "portable") });
    await expect(isCompleteJsonlFileRecordSupersequence(localPath, remotePath)).resolves.toBe(false);
    await expect(isCompleteJsonlFileRecordSupersequence(localPath, remotePath, undefined, projections())).resolves.toBe(true);
    for (const records of [remote.slice(0, -1), [metadata, read("/fixture/memory/topic.md", "changed"), read("/fixture/memory/topic.md")],
      [metadata, read("/fixture/memory/topic.md"), read("/fixture/memory/topic.md"), read("statecase://memory/unknown/topic.md")]]) {
      await writeFile(remotePath, encode(records));
      await expect(isCompleteJsonlFileRecordSupersequence(localPath, remotePath, undefined, projections())).resolves.toBe(false);
    }
    await writeFile(remotePath, encode(remote));
    await writeFile(localPath, encode(local) + '{"pending":');
    await expect(isCompleteJsonlFileRecordSupersequence(localPath, remotePath, undefined, projections())).resolves.toBe(false);
    await writeFile(localPath, encode(local.slice(1)));
    await expect(isCompleteJsonlFileRecordSupersequence(localPath, remotePath, undefined, projections())).resolves.toBe(false);
  });
  it("streams an arbitrarily large common base while bounding only each suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-file-merge-"));
    temporary.push(root);
    const basePath = join(root, "base.jsonl");
    const remotePath = join(root, "remote.jsonl");
    const localPath = join(root, "local.jsonl");
    const base = `${JSON.stringify({ id: "base", payload: "x".repeat(1024 * 1024) })}\n`;
    await writeFile(basePath, base);
    await writeFile(remotePath, `${base}{"id":"remote"}\n`);
    await writeFile(localPath, `${base}{"id":"local"}\n`);

    const merged = await mergeJsonlAppendFiles({ basePath, remotePath, localPath, maxSuffixBytes: 32 });
    expect(merged.outcome).toBe("merged");
    if (merged.outcome !== "merged") return;
    expect(await readFile(merged.path, "utf8")).toBe(`${base}{"id":"local"}\n{"id":"remote"}\n`);
    expect(merged.appendedRecords).toBe(2);
    expect(merged.size).toBe(Buffer.byteLength(`${base}{"id":"local"}\n{"id":"remote"}\n`));
    const stagedPath = merged.path;
    await merged.dispose();
    await expect(access(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for rewritten prefixes, malformed bases, incomplete suffixes, and oversized suffixes", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-file-merge-invalid-"));
    temporary.push(root);
    const basePath = join(root, "base.jsonl");
    const remotePath = join(root, "remote.jsonl");
    const localPath = join(root, "local.jsonl");
    await writeFile(basePath, "{\"id\":\"base\"}\n");
    await writeFile(remotePath, "{\"id\":\"changed\"}\n");
    await writeFile(localPath, "{\"id\":\"base\"}\n");
    await expect(mergeJsonlAppendFiles({ basePath, remotePath, localPath })).resolves
      .toEqual({ outcome: "diverged", reason: "prefix-rewritten" });

    await writeFile(remotePath, "");
    await expect(mergeJsonlAppendFiles({ basePath, remotePath, localPath })).resolves
      .toEqual({ outcome: "diverged", reason: "prefix-rewritten" });
    await writeFile(remotePath, "{\"id\":\"base\"}\n");
    await writeFile(localPath, "");
    await expect(mergeJsonlAppendFiles({ basePath, remotePath, localPath })).resolves
      .toEqual({ outcome: "diverged", reason: "prefix-rewritten" });

    await writeFile(basePath, "{broken}\n");
    await writeFile(remotePath, "{broken}\n");
    await writeFile(localPath, "{broken}\n");
    await expect(mergeJsonlAppendFiles({ basePath, remotePath, localPath })).resolves
      .toEqual({ outcome: "diverged", reason: "malformed-record" });

    await writeFile(basePath, "{\"id\":\"base\"}");
    await writeFile(remotePath, "{\"id\":\"base\"}");
    await writeFile(localPath, "{\"id\":\"base\"}");
    await expect(mergeJsonlAppendFiles({ basePath, remotePath, localPath })).resolves
      .toEqual({ outcome: "diverged", reason: "incomplete-record" });

    await writeFile(basePath, "{\"id\":\"base\"}\n");
    await writeFile(remotePath, "{\"id\":\"base\"}\n");
    await writeFile(localPath, "{\"id\":\"base\"}\n");
    await expect(mergeJsonlAppendFiles({ basePath, remotePath, localPath, maxRecordBytes: 4 })).resolves
      .toEqual({ outcome: "diverged", reason: "limit-exceeded" });

    await writeFile(remotePath, "{\"id\":\"base\"}\n{\"id\":\"tail\"}");
    await writeFile(localPath, "{\"id\":\"base\"}\n");
    await expect(mergeJsonlAppendFiles({ basePath, remotePath, localPath })).resolves
      .toEqual({ outcome: "diverged", reason: "incomplete-record" });

    await writeFile(remotePath, "{\"id\":\"base\"}\n{\"id\":\"too-large\"}\n");
    await expect(mergeJsonlAppendFiles({ basePath, remotePath, localPath, maxSuffixBytes: 4 })).resolves
      .toEqual({ outcome: "diverged", reason: "limit-exceeded" });
    await writeFile(basePath, "{}\n");
    await writeFile(remotePath, "{}\n{\"id\":\"too-large\"}\n");
    await writeFile(localPath, "{}\n");
    await expect(mergeJsonlAppendFiles({ basePath, remotePath, localPath, maxRecordBytes: 8 })).resolves
      .toEqual({ outcome: "diverged", reason: "limit-exceeded" });
  });

  it("checks record supersequences in streaming order without requiring byte-identical formatting", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-file-supersequence-"));
    temporary.push(root);
    const localPath = join(root, "local.jsonl");
    const remotePath = join(root, "remote.jsonl");
    await writeFile(localPath, "{\"id\":\"base\"}\n{\"id\":\"same\",\"kind\":1}\n{\"id\":\"same\",\"kind\":1}\n{\"id\":\"local\"}\n");
    await writeFile(remotePath, "{\"id\":\"base\"}\n{\"id\":\"remote\"}\n{\"kind\":1,\"id\":\"same\"}\n{\"kind\":1,\"id\":\"same\"}\n{\"id\":\"local\"}\n");
    await expect(isCompleteJsonlFileRecordSupersequence(localPath, remotePath)).resolves.toBe(true);

    await writeFile(remotePath, "{\"id\":\"prepended\"}\n{\"id\":\"base\"}\n{\"id\":\"same\",\"kind\":1}\n{\"id\":\"same\",\"kind\":1}\n{\"id\":\"local\"}\n");
    await expect(isCompleteJsonlFileRecordSupersequence(localPath, remotePath)).resolves.toBe(false);
    await writeFile(remotePath, "{\"id\":\"base\"}\n{\"id\":\"same\",\"kind\":1}\n");
    await expect(isCompleteJsonlFileRecordSupersequence(localPath, remotePath)).resolves.toBe(false);
    await writeFile(remotePath, "{\"id\":\"base\"}\n{\"id\":\"same\",\"kind\":1}");
    await expect(isCompleteJsonlFileRecordSupersequence(localPath, remotePath)).resolves.toBe(false);
    await writeFile(remotePath, "");
    await expect(isCompleteJsonlFileRecordSupersequence(localPath, remotePath)).resolves.toBe(false);
    await writeFile(localPath, "");
    await writeFile(remotePath, "{broken}\n");
    await expect(isCompleteJsonlFileRecordSupersequence(localPath, remotePath)).resolves.toBe(false);
  });

  it("handles empty files and CRLF records, and validates public safety limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-file-merge-edge-"));
    temporary.push(root);
    const basePath = join(root, "base.jsonl");
    const remotePath = join(root, "remote.jsonl");
    const localPath = join(root, "local.jsonl");
    await Promise.all([writeFile(basePath, ""), writeFile(remotePath, ""), writeFile(localPath, "")]);
    const empty = await mergeJsonlAppendFiles({ basePath, remotePath, localPath });
    expect(empty.outcome).toBe("merged");
    if (empty.outcome === "merged") await empty.dispose();

    await writeFile(remotePath, "{\"id\":\"remote\"}\r\n");
    await expect(isCompleteJsonlFileRecordSupersequence(localPath, remotePath)).resolves.toBe(true);
    await expect(mergeJsonlAppendFiles({ basePath, remotePath, localPath, maxSuffixBytes: 0 })).rejects.toThrow("positive");
    await expect(isCompleteJsonlFileRecordSupersequence(localPath, remotePath, 0)).rejects.toThrow("positive");

    const directory = join(root, "directory");
    await mkdir(directory);
    await expect(mergeJsonlAppendFiles({ basePath: directory, remotePath, localPath })).rejects.toThrow("regular file");
  });

  it("reports suffix ordering conflicts after accepting an exact common prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-file-merge-order-"));
    temporary.push(root);
    const basePath = join(root, "base.jsonl");
    const remotePath = join(root, "remote.jsonl");
    const localPath = join(root, "local.jsonl");
    const base = "{\"id\":\"base\"}\n";
    await writeFile(basePath, base);
    await writeFile(remotePath, `${base}{"id":"a"}\n{"id":"b"}\n`);
    await writeFile(localPath, `${base}{"id":"b"}\n{"id":"a"}\n`);

    await expect(mergeJsonlAppendFiles({ basePath, remotePath, localPath })).resolves
      .toEqual({ outcome: "diverged", reason: "order-conflict" });
  });
});
