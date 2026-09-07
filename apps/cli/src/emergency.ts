import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, copyFile, lstat, mkdir, open, readFile, readlink, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { applyFileTransaction } from "./materialize.js";
import type { ActivityHarness } from "./activity.js";

const run = promisify(execFile);
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

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
  workspace?: EmergencyWorkspaceState;
}

interface EmergencyWorkspaceState {
  headCommit: string | null;
  headRef: string | null;
  index: { kind: "absent" } | { kind: "file"; backup: string; digest: string; size: number; mode: number };
  refs: Array<{ name: string; target: string | null; recoveryRef: string | null }>;
}

const emergencyWorkspaceSchema = z.object({
  headCommit: z.string().regex(GIT_OID).nullable(),
  headRef: z.string().startsWith("refs/heads/").nullable(),
  index: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("absent") }).strict(),
    z.object({
      kind: z.literal("file"),
      backup: z.string().refine(safePortablePath),
      digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      size: z.number().int().nonnegative().safe(),
      mode: z.number().int().min(0).max(0o777),
    }).strict(),
  ]),
  refs: z.array(z.object({
    name: z.string().startsWith("refs/heads/"),
    target: z.string().regex(GIT_OID).nullable(),
    recoveryRef: z.string().startsWith("refs/statecase/recovery/").nullable(),
  }).strict()).max(2),
}).strict().superRefine((workspace, context) => {
  if (new Set(workspace.refs.map((ref) => ref.name)).size !== workspace.refs.length) {
    context.addIssue({ code: "custom", message: "duplicate workspace ref" });
  }
});

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
  workspace?: { targetHeadRef: string | null };
  /** Fault-injection boundary used by isolated consistency tests. */
  beforeFinalize?: () => void | Promise<void>;
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
  const recoveryRefs: string[] = [];
  try {
    await mkdir(join(snapshot, "files"), { mode: 0o700 });
    const workspace = input.workspace
      ? await captureWorkspaceState(targetRoot, snapshot, input.id, input.workspace.targetHeadRef, recoveryRefs)
      : undefined;
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
    await input.beforeFinalize?.();
    if (workspace) await assertEmergencySourcesStable(targetRoot, snapshot, records, workspace);
    const manifest: EmergencyManifest = {
      version: 1,
      id: input.id,
      createdAt: input.createdAt,
      targetRoot,
      harness: input.harness ?? null,
      records,
      ...(workspace ? { workspace } : {}),
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
    await Promise.all(recoveryRefs.map((ref) => gitText(targetRoot, ["update-ref", "-d", ref]).catch(() => undefined)));
    await rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}

async function assertEmergencySourcesStable(
  root: string,
  snapshot: string,
  records: readonly EmergencyRecord[],
  workspace: EmergencyWorkspaceState,
): Promise<void> {
  const currentHead = await gitText(root, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim(), () => null);
  const currentRef = await gitText(root, ["symbolic-ref", "--quiet", "HEAD"]).then((value) => value.trim(), () => null);
  if (currentHead !== workspace.headCommit || currentRef !== workspace.headRef) {
    throw new Error("workspace changed while creating its emergency snapshot");
  }
  for (const ref of workspace.refs) {
    const target = await gitText(root, ["rev-parse", "--verify", ref.name]).then((value) => value.trim(), () => null);
    if (target !== ref.target) throw new Error("workspace ref changed while creating its emergency snapshot");
  }
  const indexPath = await workspaceIndexPath(root);
  const indexInfo = await optionalLstat(indexPath);
  if (workspace.index.kind === "absent") {
    if (indexInfo) throw new Error("workspace index changed while creating its emergency snapshot");
  } else if (!indexInfo?.isFile() || Number(indexInfo.size) !== workspace.index.size ||
      await fileDigest(indexPath) !== workspace.index.digest) {
    throw new Error("workspace index changed while creating its emergency snapshot");
  }
  for (const record of records) {
    const source = safeDestination(root, record.path);
    const info = await optionalLstat(source);
    if (record.kind === "absent") {
      if (info) throw new Error(`emergency snapshot source changed while finalizing: ${record.path}`);
    } else if (record.kind === "symlink") {
      if (!info?.isSymbolicLink() || await readlink(source) !== record.target) {
        throw new Error(`emergency snapshot source changed while finalizing: ${record.path}`);
      }
    } else {
      const backup = safeDestination(snapshot, record.backup);
      if (!info?.isFile() || Number(info.size) !== record.size || (Number(info.mode) & 0o777) !== record.mode ||
          await fileDigest(source) !== await fileDigest(backup)) {
        throw new Error(`emergency snapshot source changed while finalizing: ${record.path}`);
      }
    }
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
  if (manifest.workspace) {
    await validateWorkspaceState(manifest.targetRoot, snapshot, manifest.workspace);
    const indexPath = await workspaceIndexPath(manifest.targetRoot);
    if (manifest.workspace.index.kind === "absent") deletes.push(indexPath);
    else writes.push({
      path: indexPath,
      sourcePath: safeDestination(snapshot, manifest.workspace.index.backup),
      mode: manifest.workspace.index.mode,
    });
  }
  await applyFileTransaction({ writes, symlinks, deletes });
  if (manifest.workspace) await restoreWorkspaceState(manifest.targetRoot, manifest.workspace);
}

export async function inspectEmergencySnapshot(snapshotPath: string): Promise<{
  id: string;
  targetRoot: string;
  harness: ActivityHarness | null;
  records: number;
  workspace?: true;
}> {
  const manifest = parseManifest(JSON.parse(await readFile(join(resolve(snapshotPath), "manifest.json"), "utf8")) as unknown);
  return {
    id: manifest.id,
    targetRoot: manifest.targetRoot,
    harness: manifest.harness,
    records: manifest.records.length,
    ...(manifest.workspace ? { workspace: true as const } : {}),
  };
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
  if (manifest.workspace !== undefined) validateWorkspaceManifest(manifest.workspace);
  return manifest as EmergencyManifest;
}

async function captureWorkspaceState(
  root: string,
  snapshot: string,
  snapshotId: string,
  targetHeadRef: string | null,
  createdRecoveryRefs: string[],
): Promise<EmergencyWorkspaceState> {
  if ((await gitText(root, ["rev-parse", "--is-inside-work-tree"]).catch(() => "false")).trim() !== "true") {
    throw new Error("workspace emergency snapshot requires a Git working tree");
  }
  if (targetHeadRef !== null) await validateBranch(root, targetHeadRef);
  const headCommit = await gitText(root, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim(), () => null);
  const headRef = await gitText(root, ["symbolic-ref", "--quiet", "HEAD"]).then((value) => value.trim(), () => null);
  const targetRef = targetHeadRef === null ? null : `refs/heads/${targetHeadRef}`;
  const names = [...new Set([headRef, targetRef].filter((value): value is string => value !== null))];
  const refTargets = await Promise.all(names.map(async (name) => ({
    name,
    target: await gitText(root, ["rev-parse", "--verify", name]).then((value) => value.trim(), () => null),
  })));
  await mkdir(join(snapshot, "git"), { mode: 0o700 });
  const sourceIndex = await workspaceIndexPath(root);
  const indexInfo = await optionalLstat(sourceIndex);
  let index: EmergencyWorkspaceState["index"] = { kind: "absent" };
  if (indexInfo) {
    if (!indexInfo.isFile()) throw new Error("workspace Git index is not a regular file");
    const backup = "git/index.bin";
    const backupPath = safeDestination(snapshot, backup);
    await copyFile(sourceIndex, backupPath, constants.COPYFILE_EXCL);
    const handle = await open(backupPath, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    index = {
      kind: "file",
      backup,
      digest: await fileDigest(backupPath),
      size: Number(indexInfo.size),
      mode: Number(indexInfo.mode) & 0o777,
    };
  }
  const recoveryPrefix = createHash("sha256").update(snapshotId).digest("hex").slice(0, 32);
  const refs: EmergencyWorkspaceState["refs"] = [];
  for (const [indexValue, ref] of refTargets.entries()) {
    const recoveryRef = ref.target ? `refs/statecase/recovery/${recoveryPrefix}/${indexValue}` : null;
    if (recoveryRef && ref.target) {
      await gitText(root, ["update-ref", recoveryRef, ref.target]);
      createdRecoveryRefs.push(recoveryRef);
    }
    refs.push({ ...ref, recoveryRef });
  }
  if (headCommit && !refs.some((ref) => ref.target === headCommit)) {
    const recoveryRef = `refs/statecase/recovery/${recoveryPrefix}/head`;
    await gitText(root, ["update-ref", recoveryRef, headCommit]);
    createdRecoveryRefs.push(recoveryRef);
  }
  return { headCommit, headRef, index, refs };
}

function validateWorkspaceManifest(value: unknown): asserts value is EmergencyWorkspaceState {
  if (!emergencyWorkspaceSchema.safeParse(value).success) throw new Error("invalid emergency workspace state");
}

async function validateWorkspaceState(root: string, snapshot: string, workspace: EmergencyWorkspaceState): Promise<void> {
  if ((await gitText(root, ["rev-parse", "--is-inside-work-tree"]).catch(() => "false")).trim() !== "true") {
    throw new Error("emergency snapshot target is no longer a Git working tree");
  }
  for (const ref of workspace.refs) await gitText(root, ["check-ref-format", ref.name]);
  if (workspace.headRef) await gitText(root, ["check-ref-format", workspace.headRef]);
  for (const oid of [workspace.headCommit, ...workspace.refs.map((ref) => ref.target)].filter((value): value is string => value !== null)) {
    await gitText(root, ["cat-file", "-e", `${oid}^{commit}`]).catch(() => { throw new Error("emergency workspace commit is unavailable"); });
  }
  if (workspace.index.kind === "file") {
    const backup = safeDestination(snapshot, workspace.index.backup);
    const info = await lstat(backup);
    if (!info.isFile() || info.size !== workspace.index.size || await fileDigest(backup) !== workspace.index.digest) {
      throw new Error("emergency workspace index failed digest verification");
    }
  }
}

async function restoreWorkspaceState(root: string, workspace: EmergencyWorkspaceState): Promise<void> {
  for (const ref of workspace.refs) {
    if (ref.target) await gitText(root, ["update-ref", ref.name, ref.target]);
    else await gitText(root, ["update-ref", "-d", ref.name]);
  }
  if (workspace.headRef) await gitText(root, ["symbolic-ref", "HEAD", workspace.headRef]);
  else if (workspace.headCommit) await gitText(root, ["update-ref", "--no-deref", "HEAD", workspace.headCommit]);
  else throw new Error("invalid emergency workspace HEAD state");
}

async function workspaceIndexPath(root: string): Promise<string> {
  const value = (await gitText(root, ["rev-parse", "--git-path", "index"])).trim();
  return isAbsolute(value) ? value : resolve(root, value);
}

async function validateBranch(root: string, branch: string): Promise<void> {
  await gitText(root, ["check-ref-format", "--branch", branch]).catch(() => { throw new Error("invalid workspace target head reference"); });
}

async function gitText(root: string, args: string[]): Promise<string> {
  return (await run("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;
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
