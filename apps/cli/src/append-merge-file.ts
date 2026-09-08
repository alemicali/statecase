import { createReadStream } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "@statecase/protocol";

import { mergeJsonlAppends, type JsonlAppendFailure } from "./append-merge.js";
import { createStagingDirectory } from "./disk-space.js";

const DEFAULT_MAX_SUFFIX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;

export type JsonlFileAppendMergeResult =
  | { outcome: "merged"; path: string; size: number; appendedRecords: number; dispose(): Promise<void> }
  | { outcome: "diverged"; reason: JsonlAppendFailure };

/**
 * Verifies the potentially multi-gigabyte common base as a stream and keeps
 * only the bounded concurrent suffixes in memory for deterministic DAG merge.
 */
export async function mergeJsonlAppendFiles(input: {
  basePath: string;
  remotePath: string;
  localPath: string;
  maxSuffixBytes?: number;
  maxRecordBytes?: number;
}): Promise<JsonlFileAppendMergeResult> {
  const maxSuffixBytes = input.maxSuffixBytes ?? DEFAULT_MAX_SUFFIX_BYTES;
  const maxRecordBytes = input.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  validatePositiveLimit(maxSuffixBytes, "maximum suffix size");
  validatePositiveLimit(maxRecordBytes, "maximum JSONL record size");
  const [base, remote, local] = await Promise.all([
    stableFile(input.basePath),
    stableFile(input.remotePath),
    stableFile(input.localPath),
  ]);

  const baseValidation = await validateCompleteFile(input.basePath, maxRecordBytes);
  if (baseValidation) return { outcome: "diverged", reason: baseValidation };
  if (remote.size < base.size || local.size < base.size ||
      !await hasExactFilePrefix(input.remotePath, input.basePath, base.size) ||
      !await hasExactFilePrefix(input.localPath, input.basePath, base.size)) {
    return { outcome: "diverged", reason: "prefix-rewritten" };
  }
  const remoteSuffixSize = remote.size - base.size;
  const localSuffixSize = local.size - base.size;
  if (remoteSuffixSize > maxSuffixBytes || localSuffixSize > maxSuffixBytes) {
    return { outcome: "diverged", reason: "limit-exceeded" };
  }
  const remoteSuffixValidation = await validateCompleteFile(input.remotePath, maxRecordBytes, base.size);
  if (remoteSuffixValidation) return { outcome: "diverged", reason: remoteSuffixValidation };
  const localSuffixValidation = await validateCompleteFile(input.localPath, maxRecordBytes, base.size);
  if (localSuffixValidation) return { outcome: "diverged", reason: localSuffixValidation };
  const [remoteSuffix, localSuffix] = await Promise.all([
    readRange(input.remotePath, base.size, remoteSuffixSize),
    readRange(input.localPath, base.size, localSuffixSize),
  ]);
  const merged = mergeJsonlAppends(new Uint8Array(), remoteSuffix, localSuffix);
  if (merged.outcome === "diverged") return merged;

  const root = await createStagingDirectory(
    tmpdir(),
    "statecase-session-merge-",
    base.size + merged.bytes.byteLength,
  );
  const path = join(root, "merged.jsonl");
  const destination = await open(path, "wx", 0o600);
  try {
    for await (const chunk of createReadStream(input.basePath, { highWaterMark: READ_BUFFER_BYTES })) {
      await destination.writeFile(chunk);
    }
    await destination.writeFile(merged.bytes);
    await destination.sync();
    await Promise.all([
      assertStableFile(input.basePath, base),
      assertStableFile(input.remotePath, remote),
      assertStableFile(input.localPath, local),
    ]);
  } catch (error) {
    await destination.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  await destination.close();
  return {
    outcome: "merged",
    path,
    size: base.size + merged.bytes.byteLength,
    appendedRecords: merged.appendedRecords,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/** Checks canonical record subsequence order with memory bounded by two records. */
export async function isCompleteJsonlFileRecordSupersequence(
  localPath: string,
  remotePath: string,
  maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
  projections?: { local: (record: unknown) => unknown; remote: (record: unknown) => unknown },
): Promise<boolean> {
  validatePositiveLimit(maxRecordBytes, "maximum JSONL record size");
  const local = parsedRecords(localPath, maxRecordBytes, 0, projections?.local)[Symbol.asyncIterator]();
  const remote = parsedRecords(remotePath, maxRecordBytes, 0, projections?.remote)[Symbol.asyncIterator]();
  try {
    let expected = await local.next();
    let candidate = await remote.next();
    if (expected.done) {
      while (!candidate.done) candidate = await remote.next();
      return true;
    }
    if (candidate.done || canonicalJson(expected.value) !== canonicalJson(candidate.value)) return false;
    expected = await local.next();
    candidate = await remote.next();
    while (!expected.done) {
      while (!candidate.done && canonicalJson(candidate.value) !== canonicalJson(expected.value)) {
        candidate = await remote.next();
      }
      if (candidate.done) return false;
      expected = await local.next();
      candidate = await remote.next();
    }
    while (!candidate.done) candidate = await remote.next();
    return true;
  } catch {
    return false;
  } finally {
    // Early divergence must close both file streams, including a projector
    // refusing unsupported native references partway through the history.
    await Promise.all([local.return(undefined), remote.return(undefined)]).catch(() => undefined);
  }
}

async function validateCompleteFile(path: string, maxRecordBytes: number, start = 0): Promise<JsonlAppendFailure | undefined> {
  try {
    for await (const _record of parsedRecords(path, maxRecordBytes, start)) {
      // Validation is performed by iteration; the common base is never retained.
    }
    return undefined;
  } catch (error) {
    return error instanceof JsonlFileError ? error.reason : "malformed-record";
  }
}

async function* parsedRecords(path: string, maxRecordBytes: number, start = 0, project?: (record: unknown) => unknown): AsyncGenerator<unknown> {
  let parts: Uint8Array[] = [];
  let length = 0;
  for await (const rawChunk of createReadStream(path, { highWaterMark: READ_BUFFER_BYTES, start })) {
    const chunk = new Uint8Array(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const part = chunk.subarray(start, index + 1);
      parts.push(part);
      length += part.byteLength;
      if (length > maxRecordBytes) throw new JsonlFileError("limit-exceeded");
      const original = joinParts(parts, length);
      const contentEnd = original.byteLength >= 2 && original[original.byteLength - 2] === 0x0d
        ? original.byteLength - 2
        : original.byteLength - 1;
      if (contentEnd > 0) {
        try {
          const record = JSON.parse(new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(original.subarray(0, contentEnd))) as unknown;
          yield project ? project(record) : record;
        } catch {
          throw new JsonlFileError("malformed-record");
        }
      }
      parts = [];
      length = 0;
      start = index + 1;
    }
    if (start < chunk.byteLength) {
      const remainder = chunk.subarray(start);
      parts.push(remainder);
      length += remainder.byteLength;
      if (length > maxRecordBytes) throw new JsonlFileError("limit-exceeded");
    }
  }
  if (length > 0) throw new JsonlFileError("incomplete-record");
}

async function stableFile(path: string): Promise<{ dev: number; ino: number; size: number; mtimeMs: number }> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`JSONL merge source is not a regular file: ${path}`);
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
}

async function assertStableFile(path: string, expected: Awaited<ReturnType<typeof stableFile>>): Promise<void> {
  const actual = await stableFile(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) {
    throw new Error(`JSONL merge source changed while being read: ${path}`);
  }
}

async function hasExactFilePrefix(candidatePath: string, prefixPath: string, prefixSize: number): Promise<boolean> {
  if (prefixSize === 0) return true;
  const candidate = await open(candidatePath, "r");
  const prefix = await open(prefixPath, "r");
  try {
    const candidateBuffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, prefixSize));
    const prefixBuffer = Buffer.allocUnsafe(candidateBuffer.byteLength);
    for (let position = 0; position < prefixSize;) {
      const length = Math.min(candidateBuffer.byteLength, prefixSize - position);
      const [candidateRead, prefixRead] = await Promise.all([
        candidate.read(candidateBuffer, 0, length, position),
        prefix.read(prefixBuffer, 0, length, position),
      ]);
      if (candidateRead.bytesRead !== length || prefixRead.bytesRead !== length ||
          !candidateBuffer.subarray(0, length).equals(prefixBuffer.subarray(0, length))) return false;
      position += length;
    }
    return true;
  } finally {
    await Promise.all([candidate.close(), prefix.close()]);
  }
}

async function readRange(path: string, position: number, length: number): Promise<Uint8Array> {
  if (length === 0) return new Uint8Array();
  const handle = await open(path, "r");
  const output = Buffer.allocUnsafe(length);
  try {
    let offset = 0;
    while (offset < length) {
      const read = await handle.read(output, offset, length - offset, position + offset);
      if (read.bytesRead === 0) throw new Error("JSONL merge source was truncated while being read");
      offset += read.bytesRead;
    }
    return output;
  } finally {
    await handle.close();
  }
}

function joinParts(parts: readonly Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0]!.slice();
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function validatePositiveLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be positive`);
}

class JsonlFileError extends Error {
  constructor(readonly reason: JsonlAppendFailure) {
    super(reason);
  }
}
