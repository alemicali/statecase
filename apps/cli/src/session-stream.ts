import { createReadStream } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import {
  AdapterFormatError,
  extractActivityReferences,
  sessionWorkingDirectory,
  type ActivityReference,
} from "@statecase/adapter-common";

import { assertTemporarySpace, createStagingDirectory } from "./disk-space.js";

const DEFAULT_MAX_RECORD_BYTES = 64 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf8", { fatal: true, ignoreBOM: false });

export interface SessionWorkspace {
  id: string;
  path: string;
}

export interface StagedSession {
  path: string;
  size: number;
  workspaceId?: string;
  activity: ActivityReference[];
  dispose(): Promise<void>;
}

export async function inspectPortableSessionActivity(
  sourcePath: string,
  workspaceId: string,
  workspacePath: string,
  options: { maxRecordBytes?: number } = {},
): Promise<ActivityReference[]> {
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
    throw new RangeError("maximum JSONL record size must be positive");
  }
  let cwd: string | undefined;
  const activity = new Map<string, ActivityReference>();
  const accepted = await forEachCompleteRecord(sourcePath, maxRecordBytes, async (record) => {
    const localized = transformStrings(record, (value) => localizeWorkspaceUri(value, workspaceId, workspacePath));
    cwd = sessionWorkingDirectory([localized]) ?? cwd;
    const records = cwd ? [{ type: "session_meta", cwd }, localized] : [localized];
    for (const reference of extractActivityReferences(records)) {
      activity.set(`${reference.access}\0${reference.path}`, reference);
    }
  });
  if (accepted !== (await lstat(sourcePath)).size) throw new Error("portable session has an incomplete JSONL tail");
  return [...activity.values()];
}

export async function localizePortableSession(
  sourcePath: string,
  destinationPath: string,
  workspaceId: string,
  workspacePath: string,
  options: { maxRecordBytes?: number } = {},
): Promise<number> {
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
    throw new RangeError("maximum JSONL record size must be positive");
  }
  const source = await lstat(sourcePath);
  if (!source.isFile()) throw new Error("portable session source is not a regular file");
  await assertTemporarySpace(dirname(destinationPath), source.size);
  const destination = await open(destinationPath, "wx", 0o600);
  let written = 0;
  let accepted = 0;
  try {
    accepted = await forEachCompleteRecord(sourcePath, maxRecordBytes, async (record) => {
      const transformed = transformStrings(record, (value) => {
        return localizeWorkspaceUri(value, workspaceId, workspacePath);
      });
      const bytes = encoder.encode(`${JSON.stringify(transformed)}\n`);
      await destination.writeFile(bytes);
      written += bytes.byteLength;
    });
    if (accepted !== (await lstat(sourcePath)).size) throw new Error("portable session has an incomplete JSONL tail");
    await destination.sync();
  } finally {
    await destination.close();
  }
  return written;
}

export function localizeWorkspaceUri(value: string, workspaceId: string, workspacePath: string): string {
  const prefix = `statecase://workspace/${workspaceId}`;
  const root = resolve(workspacePath);
  if (value === prefix) return root;
  if (!value.startsWith(`${prefix}/`)) return value;
  const components = value.slice(prefix.length + 1).split("/");
  if (components.some((component) =>
    component === "" || component === "." || component === ".." || component.includes("\\") || component.includes("\0")
  )) {
    throw new Error("portable session contains an unsafe workspace path");
  }
  const localized = resolve(root, ...components);
  if (localized !== root && !localized.startsWith(`${root}${sep}`)) {
    throw new Error("portable session workspace path escapes its mapped root");
  }
  return localized;
}

export async function stagePortableSession(
  sourcePath: string,
  workspaces: readonly SessionWorkspace[],
  options: { maxRecordBytes?: number } = {},
): Promise<StagedSession | undefined> {
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
    throw new RangeError("maximum JSONL record size must be positive");
  }
  const before = await lstat(sourcePath);
  if (!before.isFile()) throw new Error("session source is not a regular file");
  const stagingRoot = await createStagingDirectory(tmpdir(), "statecase-session-", before.size, 2);
  const acceptedPath = join(stagingRoot, "accepted.jsonl");
  const portablePath = join(stagingRoot, "portable.jsonl");
  const accepted = await open(acceptedPath, "wx", 0o600);
  let cwd: string | undefined;
  const matchedWorkspaceIds = new Set<string>();
  const activity = new Map<string, ActivityReference>();
  let acceptedSize = 0;

  try {
    await forEachCompleteRecord(sourcePath, maxRecordBytes, async (record, original) => {
      await accepted.writeFile(original);
      acceptedSize += original.byteLength;
      cwd = sessionWorkingDirectory([record]) ?? cwd;
      transformStrings(record, (value) => {
        if (isAbsolute(value)) {
          const matched = longestContainingWorkspace(workspaces, value);
          if (matched) matchedWorkspaceIds.add(matched.id);
        }
        return value;
      });
      const records = cwd ? [{ type: "session_meta", cwd }, record] : [record];
      for (const reference of extractActivityReferences(records)) {
        activity.set(`${reference.access}\0${reference.path}`, reference);
      }
    });
  } catch (error) {
    await accepted.close();
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  await accepted.close();
  const after = await lstat(sourcePath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw new Error("session changed while being scanned");
  }
  if (acceptedSize === 0) {
    await rm(stagingRoot, { recursive: true, force: true });
    return undefined;
  }

  const cwdWorkspace = cwd ? longestContainingWorkspace(workspaces, cwd) : undefined;
  const workspace = cwdWorkspace ?? (matchedWorkspaceIds.size === 1
    ? workspaces.find((candidate) => candidate.id === [...matchedWorkspaceIds][0])
    : undefined);
  let path = acceptedPath;
  let size = acceptedSize;
  if (workspace) {
    const portable = await open(portablePath, "wx", 0o600);
    size = 0;
    try {
      await forEachCompleteRecord(acceptedPath, maxRecordBytes, async (record) => {
        const transformed = transformStrings(record, (value) => portablePathValue(value, workspace));
        const bytes = encoder.encode(`${JSON.stringify(transformed)}\n`);
        await portable.writeFile(bytes);
        size += bytes.byteLength;
      });
    } finally {
      await portable.close();
    }
    path = portablePath;
  }

  return {
    path,
    size,
    ...(workspace ? { workspaceId: workspace.id } : {}),
    activity: [...activity.values()],
    dispose: () => rm(stagingRoot, { recursive: true, force: true }),
  };
}

async function forEachCompleteRecord(
  path: string,
  maxRecordBytes: number,
  accept: (record: unknown, original: Uint8Array) => Promise<void>,
): Promise<number> {
  let parts: Uint8Array[] = [];
  let length = 0;
  let offset = 0;
  for await (const rawChunk of createReadStream(path, { highWaterMark: READ_BUFFER_BYTES })) {
    const chunk = new Uint8Array(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const part = chunk.subarray(start, index + 1);
      parts.push(part);
      length += part.byteLength;
      if (length > maxRecordBytes) throw new Error(`session JSONL record exceeds ${maxRecordBytes} bytes`);
      const original = joinParts(parts, length);
      const contentEnd = original.byteLength >= 2 && original[original.byteLength - 2] === 0x0d
        ? original.byteLength - 2
        : original.byteLength - 1;
      if (contentEnd > 0) {
        let record: unknown;
        try {
          record = JSON.parse(decoder.decode(original.subarray(0, contentEnd))) as unknown;
        } catch {
          throw new AdapterFormatError("MALFORMED_COMPLETE_RECORD", `malformed complete JSONL record at byte ${offset}`);
        }
        await accept(record, original);
      }
      offset += original.byteLength;
      parts = [];
      length = 0;
      start = index + 1;
    }
    if (start < chunk.byteLength) {
      const remainder = chunk.subarray(start);
      parts.push(remainder);
      length += remainder.byteLength;
      if (length > maxRecordBytes) throw new Error(`session JSONL record exceeds ${maxRecordBytes} bytes`);
    }
  }
  return offset;
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

function longestContainingWorkspace(workspaces: readonly SessionWorkspace[], cwd: string): SessionWorkspace | undefined {
  return [...workspaces]
    .sort((left, right) => resolve(right.path).length - resolve(left.path).length)
    .find((workspace) => within(resolve(workspace.path), cwd));
}

function portablePathValue(value: string, workspace: SessionWorkspace): string {
  if (!isAbsolute(value)) return value;
  const root = resolve(workspace.path);
  if (!within(root, value)) return value;
  const suffix = relative(root, normalize(value)).split(sep).join("/");
  return `statecase://workspace/${workspace.id}${suffix ? `/${suffix}` : ""}`;
}

function within(root: string, candidate: string): boolean {
  const absolute = resolve(candidate);
  return absolute === root || absolute.startsWith(`${root}${sep}`);
}

function transformStrings(value: unknown, transform: (value: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((entry) => transformStrings(entry, transform));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, transformStrings(entry, transform)]));
  }
  return value;
}
