import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, copyFile, lstat, mkdir, open, readFile, readlink, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { applyFileTransaction } from "./materialize.js";
import type { ActivityHarness } from "./activity.js";

interface EmergencyRecordBase {
  path: string;
}

type EmergencyRecord = EmergencyRecordBase & (
  | { kind: "absent" }
  | { kind: "file"; backup: string; digest: string; size: number; mode: number }
  | { kind: "symlink"; target: string }
);

interface EmergencyManifest {
  version: 1;
  id: string;
  createdAt: string;
  targetRoot: string;
  harness: ActivityHarness | null;
  records: EmergencyRecord[];
}

export interface EmergencySnapshot {
  id: string;
  path: string;
  records: number;
}

export async function createEmergencySnapshot(input: {
  id: string;
  createdAt: string;
  statecaseHome: string;
  targetRoot: string;
  paths: readonly string[];
  harness?: ActivityHarness;
}): Promise<EmergencySnapshot> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.id)) throw new TypeError("emergency snapshot ID is invalid");
  if (Number.isNaN(Date.parse(input.createdAt))) throw new TypeError("emergency snapshot timestamp is invalid");
  const targetRoot = resolve(input.targetRoot);
  const targetInfo = await lstat(targetRoot);
  if (!targetInfo.isDirectory()) throw new Error("emergency snapshot target root must be a real directory");
  const snapshot = join(resolve(input.statecaseHome), "recovery", input.id);
  if (within(targetRoot, snapshot)) throw new Error("emergency snapshot storage cannot be inside its restore target");
  const selected = [...new Set(input.paths.map((path) => resolve(path)))].sort((left, right) => left.localeCompare(right, "en"));
  for (const path of selected) {
    if (!within(targetRoot, path) || path === targetRoot) throw new Error("emergency snapshot path is outside its target root");
  }

  await mkdir(join(resolve(input.statecaseHome), "recovery"), { recursive: true, mode: 0o700 });
  await mkdir(snapshot, { mode: 0o700 });
  try {
    await mkdir(join(snapshot, "files"), { mode: 0o700 });
    const records: EmergencyRecord[] = [];
    for (const [index, path] of selected.entries()) {
      const relativePath = portableRelative(targetRoot, path);
      const before = await optionalLstat(path);
      if (!before) {
        records.push({ path: relativePath, kind: "absent" });
        continue;
      }
      if (before.isSymbolicLink()) {
        records.push({ path: relativePath, kind: "symlink", target: await readlink(path) });
        continue;
      }
      if (!before.isFile()) throw new Error(`emergency snapshot refuses non-regular target: ${relativePath}`);
      const backup = `files/${String(index).padStart(8, "0")}.bin`;
      const backupPath = join(snapshot, ...backup.split("/"));
      await copyFile(path, backupPath, constants.COPYFILE_EXCL);
      const backupHandle = await open(backupPath, "r");
      try { await backupHandle.sync(); } finally { await backupHandle.close(); }
      const after = await lstat(path);
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`emergency snapshot source changed while copying: ${relativePath}`);
      }
      records.push({
        path: relativePath,
        kind: "file",
        backup,
        digest: await fileDigest(backupPath),
        size: before.size,
        mode: Number(before.mode) & 0o777,
      });
    }
    const manifest: EmergencyManifest = {
      version: 1,
      id: input.id,
      createdAt: input.createdAt,
      targetRoot,
      harness: input.harness ?? null,
      records,
    };
    const manifestHandle = await open(join(snapshot, "manifest.json"), "wx", 0o600);
    try {
      await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    return { id: input.id, path: snapshot, records: records.length };
  } catch (error) {
    await rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreEmergencySnapshot(snapshotPath: string): Promise<void> {
  const snapshot = resolve(snapshotPath);
  const manifest = parseManifest(JSON.parse(await readFile(join(snapshot, "manifest.json"), "utf8")) as unknown);
  const writes: Array<{ path: string; sourcePath: string; mode: number }> = [];
  const symlinks: Array<{ path: string; target: string }> = [];
  const deletes: string[] = [];
  for (const record of manifest.records) {
    const target = safeDestination(manifest.targetRoot, record.path);
    if (record.kind === "absent") {
      deletes.push(target);
      continue;
    }
    if (record.kind === "symlink") {
      symlinks.push({ path: target, target: record.target });
      continue;
    }
    const backup = safeDestination(snapshot, record.backup);
    const info = await lstat(backup);
    if (!info.isFile() || info.size !== record.size || await fileDigest(backup) !== record.digest) {
      throw new Error(`emergency snapshot backup failed digest verification: ${record.path}`);
    }
    writes.push({ path: target, sourcePath: backup, mode: record.mode });
  }
  await applyFileTransaction({ writes, symlinks, deletes });
}

export async function inspectEmergencySnapshot(snapshotPath: string): Promise<{
  id: string;
  targetRoot: string;
  harness: ActivityHarness | null;
  records: number;
}> {
  const manifest = parseManifest(JSON.parse(await readFile(join(resolve(snapshotPath), "manifest.json"), "utf8")) as unknown);
  return { id: manifest.id, targetRoot: manifest.targetRoot, harness: manifest.harness, records: manifest.records.length };
}

function parseManifest(value: unknown): EmergencyManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid emergency snapshot manifest");
  const manifest = value as Partial<EmergencyManifest>;
  if (manifest.version !== 1 || typeof manifest.id !== "string" || typeof manifest.createdAt !== "string" ||
      typeof manifest.targetRoot !== "string" || !isAbsolute(manifest.targetRoot) || !Array.isArray(manifest.records) ||
      (manifest.harness !== null && manifest.harness !== "codex" && manifest.harness !== "claude") ||
      manifest.records.length > 100_000) throw new Error("invalid emergency snapshot manifest");
  const paths = new Set<string>();
  for (const unknownRecord of manifest.records) {
    if (!unknownRecord || typeof unknownRecord !== "object" || Array.isArray(unknownRecord)) throw new Error("invalid emergency snapshot record");
    const record = unknownRecord as Partial<EmergencyRecord>;
    if (typeof record.path !== "string" || !safePortablePath(record.path) || paths.has(record.path)) throw new Error("invalid emergency snapshot record");
    paths.add(record.path);
    if (record.kind === "absent") continue;
    if (record.kind === "symlink" && typeof record.target === "string" && !record.target.includes("\0")) continue;
    if (record.kind === "file" && typeof record.backup === "string" && safePortablePath(record.backup) &&
        typeof record.digest === "string" && /^[A-Za-z0-9_-]{43}$/u.test(record.digest) &&
        Number.isSafeInteger(record.size) && record.size! >= 0 && Number.isSafeInteger(record.mode) && record.mode! >= 0 && record.mode! <= 0o777) continue;
    throw new Error("invalid emergency snapshot record");
  }
  return manifest as EmergencyManifest;
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (!safePortablePath(value)) throw new Error("emergency snapshot path is outside its target root");
  return value;
}

function safeDestination(root: string, portablePath: string): string {
  if (!safePortablePath(portablePath)) throw new Error("unsafe emergency snapshot path");
  const destination = resolve(root, ...portablePath.split("/"));
  if (!within(resolve(root), destination)) throw new Error("unsafe emergency snapshot path");
  return destination;
}

function safePortablePath(path: string): boolean {
  if (path.length === 0 || path.length > 4096 || path.includes("\0") || path.includes("\\") || isAbsolute(path)) return false;
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function within(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("base64url");
}
