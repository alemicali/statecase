import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_CAPSULE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_CAPSULE_RECORDS = 100_000;
const GIT_FETCH_TIMEOUT_MS = 60_000;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REGULAR_MODES = new Set([0o100644, 0o100755]);
const CONTENT_MODES = new Set([...REGULAR_MODES, 0o120000]);

export type IndexState = "base" | "absent" | "content" | "submodule";
export type WorktreeState = "index" | "absent" | "content" | "submodule";
export type WorkspaceLayer = "index" | "worktree";
export type GitFetchPolicy = "ask" | "auto" | "never";

export class WorkspaceBaselineUnavailable extends Error {
  readonly code = "BASELINE_UNAVAILABLE" as const;

  constructor(
    readonly baseCommit: string | null,
    readonly reason: "approval-required" | "policy-disabled" | "no-origin" | "fetch-failed" | "checkout-failed" | "unborn-mismatch",
  ) {
    super(baselineUnavailableMessage(reason));
    this.name = "WorkspaceBaselineUnavailable";
  }
}

export interface WorkspaceRecord {
  path: string;
  index: { state: IndexState; mode?: number; oid?: string };
  worktree: { state: WorktreeState; mode?: number; oid?: string };
}

export interface WorkspaceCapsuleV1 {
  schemaVersion: 1;
  baseCommit: string | null;
  headRef: string | null;
  records: WorkspaceRecord[];
}

export interface WorkspaceBlob {
  layer: WorkspaceLayer;
  path: string;
  bytes: Uint8Array;
  mode: number;
  oid: string;
}

export interface CapturedWorkspace {
  capsule: WorkspaceCapsuleV1;
  blobs: WorkspaceBlob[];
}

export interface WorkspaceMaterializer {
  (transaction: {
    writes: Array<{ path: string; bytes: Uint8Array; mode?: number }>;
    symlinks?: Array<{ path: string; target: string }>;
    deletes: string[];
  }): Promise<void>;
}

export interface WorkspaceApplication {
  root: string;
  captured: CapturedWorkspace;
  gitFetch?: GitFetchPolicy;
}

export interface WorkspaceFileTransaction {
  writes: Array<{ path: string; bytes: Uint8Array; mode?: number }>;
  symlinks?: Array<{ path: string; target: string }>;
  deletes: string[];
}

interface GitEntry {
  mode: number;
  oid: string;
  stage?: number;
}

export async function captureWorkspace(rootValue: string): Promise<CapturedWorkspace> {
  const root = resolve(rootValue);
  if ((await gitText(root, ["rev-parse", "--is-inside-work-tree"]).catch(() => "false")).trim() !== "true") {
    throw new Error(`workspace is not a Git working tree: ${root}`);
  }
  const baseCommit = await gitText(root, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim(), () => null);
  const headRef = await gitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((value) => value.trim(), () => null);
  const [head, index, worktreeChanged, indexChanged, untracked] = await Promise.all([
    baseCommit ? readHeadEntries(root, baseCommit) : new Map<string, GitEntry>(),
    readIndexEntries(root),
    gitBuffer(root, ["diff", "--name-only", "-z"]),
    gitBuffer(root, ["diff", "--cached", "--name-only", "-z"]),
    gitBuffer(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const changed = new Set([...nulPaths(worktreeChanged), ...nulPaths(indexChanged), ...nulPaths(untracked)]);
  const records: WorkspaceRecord[] = [];
  const blobs: WorkspaceBlob[] = [];

  for (const path of [...changed].sort((left, right) => left.localeCompare(right, "en"))) {
    requireLogicalPath(path);
    const headEntry = head.get(path);
    const indexEntry = index.get(path);
    const indexLayer = await captureIndexLayer(root, path, headEntry, indexEntry, blobs);
    const worktreeLayer = await captureWorktreeLayer(root, path, indexEntry, blobs);
    records.push({ path, index: indexLayer, worktree: worktreeLayer });
  }
  return { capsule: { schemaVersion: 1, baseCommit, headRef, records }, blobs };
}

export async function applyWorkspaceCapsule(
  rootValue: string,
  captured: CapturedWorkspace,
  options: { materialize: WorkspaceMaterializer; gitFetch?: GitFetchPolicy },
): Promise<void> {
  await applyWorkspaceTransaction([{ root: rootValue, captured, gitFetch: options.gitFetch }], { writes: [], deletes: [] }, options);
}

/** Applies ordinary files and one or more Git overlays as one filesystem revision. */
export async function applyWorkspaceTransaction(
  applications: readonly WorkspaceApplication[],
  initial: WorkspaceFileTransaction,
  options: { materialize: WorkspaceMaterializer },
): Promise<void> {
  const roots = applications.map((application) => resolve(application.root));
  if (new Set(roots).size !== roots.length) throw new Error("duplicate workspace transaction root");
  const inspections = await Promise.all(applications.map((application, index) => inspectWorkspaceDestination(
    roots[index]!,
    application.captured,
    application.gitFetch ?? "ask",
  )));
  const baselineChanges: BaselineChange[] = [];
  const prepared: Array<{
    root: string;
    captured: CapturedWorkspace;
    indexPath: string;
    originalIndex: Uint8Array | undefined;
    blobMap: Map<string, WorkspaceBlob>;
  }> = [];

  try {
    for (const inspection of inspections) baselineChanges.push(await acquireWorkspaceBaseline(inspection));
    for (const [index, application] of applications.entries()) {
      const root = roots[index]!;
      const indexPathValue = (await gitText(root, ["rev-parse", "--git-path", "index"])).trim();
      const indexPath = isAbsolute(indexPathValue) ? indexPathValue : resolve(root, indexPathValue);
      const originalIndex = await readFile(indexPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      prepared.push({
        root,
        captured: application.captured,
        indexPath,
        originalIndex,
        blobMap: new Map(application.captured.blobs.map((blob) => [blobKey(blob.layer, blob.path), blob])),
      });
    }
    const transaction: WorkspaceFileTransaction = {
      writes: [...initial.writes],
      symlinks: [...(initial.symlinks ?? [])],
      deletes: [...initial.deletes],
    };
    for (const workspace of prepared) {
      for (const record of workspace.captured.capsule.records) await applyIndexRecord(workspace.root, record, workspace.blobMap);
      for (const record of workspace.captured.capsule.records) {
        const destination = destinationPath(workspace.root, record.path);
        if (record.worktree.state === "absent") {
          transaction.deletes.push(destination);
        } else if (record.worktree.state === "content") {
          const blob = requireBlob(workspace.blobMap, "worktree", record.path, record.worktree.oid);
          if (blob.mode === 0o120000) transaction.symlinks!.push({ path: destination, target: safeSymlinkTarget(workspace.root, destination, blob.bytes) });
          else transaction.writes.push({ path: destination, bytes: blob.bytes, mode: filesystemMode(blob.mode) });
        } else if (record.worktree.state === "index" && record.index.state === "content") {
          const blob = requireBlob(workspace.blobMap, "index", record.path, record.index.oid);
          if (blob.mode === 0o120000) transaction.symlinks!.push({ path: destination, target: safeSymlinkTarget(workspace.root, destination, blob.bytes) });
          else transaction.writes.push({ path: destination, bytes: blob.bytes, mode: filesystemMode(blob.mode) });
        }
      }
    }
    await options.materialize(transaction);
  } catch (error) {
    const failures: unknown[] = [];
    for (const workspace of [...prepared].reverse()) {
      try {
        await restoreIndex(workspace.indexPath, workspace.originalIndex);
      } catch (restoreError) {
        failures.push(restoreError);
      }
    }
    for (const baseline of [...baselineChanges].reverse()) {
      try {
        await rollbackWorkspaceBaseline(baseline);
      } catch (restoreError) {
        failures.push(restoreError);
      }
    }
    if (failures.length > 0) throw new AggregateError([error, ...failures], "workspace apply failed and index rollback was incomplete");
    throw error;
  }
}

interface BaselineInspection {
  root: string;
  baseCommit: string | null;
  currentCommit: string | null;
  currentRef: string | null;
  fetch: boolean;
  checkout: boolean;
}

interface BaselineChange {
  root: string;
  changed: boolean;
  originalCommit: string | null;
  originalRef: string | null;
}

export async function assertWorkspaceDestination(
  rootValue: string,
  captured: CapturedWorkspace,
  options: { gitFetch?: GitFetchPolicy } = {},
): Promise<void> {
  await inspectWorkspaceDestination(rootValue, captured, options.gitFetch ?? "never");
}

export async function inspectWorkspaceDestination(
  rootValue: string,
  captured: CapturedWorkspace,
  gitFetch: GitFetchPolicy = "ask",
): Promise<BaselineInspection> {
  const root = resolve(rootValue);
  validateCaptured(captured);
  if ((await gitText(root, ["rev-parse", "--is-inside-work-tree"]).catch(() => "false")).trim() !== "true") {
    throw new Error(`workspace is not a Git working tree: ${root}`);
  }
  const currentBase = await gitText(root, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim(), () => null);
  const currentRef = await gitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((value) => value.trim(), () => null);
  if ((await gitBuffer(root, ["status", "--porcelain=v1", "-z"])).byteLength > 0) {
    throw new Error("workspace destination is dirty; refusing to apply capsule");
  }
  for (const blob of captured.blobs) {
    const oid = (await gitInput(root, ["hash-object", "--stdin"], blob.bytes)).toString("utf8").trim();
    if (oid !== blob.oid) throw new Error(`workspace blob digest does not match: ${blob.path}`);
    if (blob.mode === 0o120000) safeSymlinkTarget(root, destinationPath(root, blob.path), blob.bytes);
  }
  if (currentBase === captured.capsule.baseCommit) {
    return { root, baseCommit: captured.capsule.baseCommit, currentCommit: currentBase, currentRef, fetch: false, checkout: false };
  }
  if (gitFetch !== "auto") {
    throw new WorkspaceBaselineUnavailable(captured.capsule.baseCommit, gitFetch === "ask" ? "approval-required" : "policy-disabled");
  }
  if (!captured.capsule.baseCommit) throw new WorkspaceBaselineUnavailable(null, "unborn-mismatch");
  const present = await gitObjectExists(root, captured.capsule.baseCommit);
  if (!present && !await hasOrigin(root)) throw new WorkspaceBaselineUnavailable(captured.capsule.baseCommit, "no-origin");
  return { root, baseCommit: captured.capsule.baseCommit, currentCommit: currentBase, currentRef, fetch: !present, checkout: true };
}

export async function workspaceMatchesCapsule(rootValue: string, expected: CapturedWorkspace): Promise<boolean> {
  try {
    const current = await captureWorkspace(rootValue);
    return JSON.stringify(capsuleIdentity(current.capsule)) === JSON.stringify(capsuleIdentity(expected.capsule)) &&
      JSON.stringify(current.blobs.map(blobIdentity).sort(compareBlobIdentity)) ===
      JSON.stringify(expected.blobs.map(blobIdentity).sort(compareBlobIdentity));
  } catch {
    return false;
  }
}

function capsuleIdentity(capsule: WorkspaceCapsuleV1): WorkspaceCapsuleV1 {
  return {
    schemaVersion: capsule.schemaVersion,
    baseCommit: capsule.baseCommit,
    headRef: capsule.headRef,
    records: capsule.records.map((record) => ({
      path: record.path,
      index: { state: record.index.state, ...(record.index.mode === undefined ? {} : { mode: record.index.mode }), ...(record.index.oid === undefined ? {} : { oid: record.index.oid }) },
      worktree: { state: record.worktree.state, ...(record.worktree.mode === undefined ? {} : { mode: record.worktree.mode }), ...(record.worktree.oid === undefined ? {} : { oid: record.worktree.oid }) },
    })),
  };
}

async function captureIndexLayer(
  root: string,
  path: string,
  head: GitEntry | undefined,
  index: GitEntry | undefined,
  blobs: WorkspaceBlob[],
): Promise<WorkspaceRecord["index"]> {
  if (!index) return { state: "absent" };
  if (head && head.mode === index.mode && head.oid === index.oid) return { state: "base" };
  if (index.mode === 0o160000) return { state: "submodule", mode: index.mode, oid: index.oid };
  const bytes = new Uint8Array(await gitBuffer(root, ["cat-file", "blob", index.oid]));
  blobs.push({ layer: "index", path, bytes, mode: index.mode, oid: index.oid });
  return { state: "content", mode: index.mode, oid: index.oid };
}

async function captureWorktreeLayer(
  root: string,
  path: string,
  index: GitEntry | undefined,
  blobs: WorkspaceBlob[],
): Promise<WorkspaceRecord["worktree"]> {
  const destination = destinationPath(root, path);
  const info = await lstat(destination).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!info) return { state: "absent" };
  if (info.isDirectory() && index?.mode === 0o160000) {
    throw new Error(`initialized submodule worktrees are not supported: ${path}`);
  }
  let bytes: Uint8Array;
  let mode: number;
  if (info.isSymbolicLink()) {
    const target = await readlink(destination);
    if (isAbsolute(target) || resolve(dirname(destination), target) === root || !resolve(dirname(destination), target).startsWith(`${root}${sep}`)) {
      throw new Error(`unsafe workspace symlink: ${path}`);
    }
    bytes = new TextEncoder().encode(target);
    mode = 0o120000;
  } else if (info.isFile()) {
    if (info.size > MAX_FILE_BYTES) throw new Error(`workspace file exceeds safety limit: ${path}`);
    bytes = new Uint8Array(await readFile(destination));
    mode = (info.mode & 0o111) === 0 ? 0o100644 : 0o100755;
  } else {
    throw new Error(`unsupported workspace entry: ${path}`);
  }
  const oid = (await gitInput(root, ["hash-object", "--stdin"], bytes)).toString("utf8").trim();
  if (index && index.mode === mode && index.oid === oid) return { state: "index" };
  blobs.push({ layer: "worktree", path, bytes, mode, oid });
  return { state: "content", mode, oid };
}

async function applyIndexRecord(root: string, record: WorkspaceRecord, blobs: Map<string, WorkspaceBlob>): Promise<void> {
  if (record.index.state === "base") return;
  if (record.index.state === "absent") {
    await gitText(root, ["update-index", "--force-remove", "--", record.path]);
    return;
  }
  if (!record.index.oid || !record.index.mode) throw new Error(`capsule index metadata is incomplete: ${record.path}`);
  if (record.index.state === "content") {
    const blob = requireBlob(blobs, "index", record.path, record.index.oid);
    const oid = (await gitInput(root, ["hash-object", "-w", "--stdin"], blob.bytes)).toString("utf8").trim();
    if (oid !== record.index.oid) throw new Error(`capsule index blob digest mismatch: ${record.path}`);
  }
  await gitText(root, ["update-index", "--add", "--cacheinfo", record.index.mode.toString(8), record.index.oid, record.path]);
}

function validateCaptured(captured: CapturedWorkspace): void {
  if (!captured || typeof captured !== "object" || !captured.capsule || typeof captured.capsule !== "object") {
    throw new Error("invalid workspace capsule");
  }
  if (captured.capsule.schemaVersion !== 1) throw new Error("unsupported workspace capsule version");
  if (captured.capsule.baseCommit !== null && (typeof captured.capsule.baseCommit !== "string" || !GIT_OID.test(captured.capsule.baseCommit))) {
    throw new Error("invalid workspace baseline object ID");
  }
  if (captured.capsule.headRef !== null && (typeof captured.capsule.headRef !== "string" || captured.capsule.headRef.length === 0 ||
      captured.capsule.headRef.length > 1024 || containsControlCharacter(captured.capsule.headRef))) {
    throw new Error("invalid workspace head reference");
  }
  if (!Array.isArray(captured.capsule.records) || captured.capsule.records.length > MAX_CAPSULE_RECORDS || !Array.isArray(captured.blobs) || captured.blobs.length > MAX_CAPSULE_RECORDS * 2) {
    throw new Error("workspace capsule exceeds structural limits");
  }
  const records = new Set<string>();
  const requiredBlobs = new Map<string, { mode: number; oid: string }>();
  let previousPath: string | undefined;
  for (const record of captured.capsule.records) {
    if (!record || typeof record !== "object" || typeof record.path !== "string" || !record.index || !record.worktree) {
      throw new Error("invalid workspace record");
    }
    requireLogicalPath(record.path);
    if (record.path.length > 4096) throw new Error("workspace path exceeds safety limit");
    if (records.has(record.path)) throw new Error(`duplicate workspace path: ${record.path}`);
    if (previousPath !== undefined && previousPath.localeCompare(record.path, "en") >= 0) throw new Error("workspace records are not canonically ordered");
    records.add(record.path);
    previousPath = record.path;
    validateLayerState("index", record.path, record.index, requiredBlobs);
    validateLayerState("worktree", record.path, record.worktree, requiredBlobs);
    if (record.worktree.state === "index" && record.index.state !== "base" && record.index.state !== "content") {
      throw new Error(`invalid workspace state relationship: ${record.path}`);
    }
  }
  const blobs = new Set<string>();
  let totalBytes = 0;
  for (const blob of captured.blobs) {
    if (!blob || typeof blob !== "object" || (blob.layer !== "index" && blob.layer !== "worktree") || typeof blob.path !== "string" ||
        !(blob.bytes instanceof Uint8Array) || typeof blob.mode !== "number" || typeof blob.oid !== "string") {
      throw new Error("invalid workspace blob");
    }
    requireLogicalPath(blob.path);
    const key = blobKey(blob.layer, blob.path);
    if (blobs.has(key)) throw new Error(`duplicate workspace blob: ${blob.path}`);
    const required = requiredBlobs.get(key);
    if (!required) throw new Error(`unreferenced workspace blob: ${blob.path}`);
    if (required.mode !== blob.mode || required.oid !== blob.oid) throw new Error(`workspace blob metadata does not match: ${blob.path}`);
    if (blob.bytes.byteLength > MAX_FILE_BYTES) throw new Error(`workspace blob exceeds safety limit: ${blob.path}`);
    totalBytes += blob.bytes.byteLength;
    if (totalBytes > MAX_CAPSULE_BYTES) throw new Error("workspace capsule exceeds byte limit");
    blobs.add(key);
  }
  for (const key of requiredBlobs.keys()) if (!blobs.has(key)) throw new Error("referenced workspace blob is missing");
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
}

function validateLayerState(
  layer: WorkspaceLayer,
  path: string,
  value: WorkspaceRecord[WorkspaceLayer],
  requiredBlobs: Map<string, { mode: number; oid: string }>,
): void {
  if (!value || typeof value !== "object" || !new Set(["base", "absent", "content", "submodule", "index"]).has(value.state)) {
    throw new Error(`invalid workspace state: ${path}`);
  }
  if (layer === "index" && value.state === "index" || layer === "worktree" && value.state === "base") {
    throw new Error(`invalid workspace state for ${layer}: ${path}`);
  }
  if (value.state === "base" || value.state === "absent" || value.state === "index") {
    if (value.mode !== undefined || value.oid !== undefined) throw new Error(`unexpected workspace metadata: ${path}`);
    return;
  }
  if (typeof value.mode !== "number" || !Number.isInteger(value.mode) || typeof value.oid !== "string" || !GIT_OID.test(value.oid)) {
    throw new Error(`invalid workspace mode or object ID: ${path}`);
  }
  if (value.state === "submodule") {
    if (value.mode !== 0o160000) throw new Error(`invalid workspace mode: ${path}`);
    if (layer === "worktree") throw new Error(`initialized submodule worktrees are not supported: ${path}`);
    return;
  }
  if (!CONTENT_MODES.has(value.mode)) throw new Error(`invalid workspace mode: ${path}`);
  requiredBlobs.set(blobKey(layer, path), { mode: value.mode, oid: value.oid });
}

async function readHeadEntries(root: string, commit: string): Promise<Map<string, GitEntry>> {
  const output = await gitBuffer(root, ["ls-tree", "-r", "-z", commit]);
  const entries = new Map<string, GitEntry>();
  for (const record of nulPaths(output)) {
    const match = /^(\d+) (?:blob|commit) ([0-9a-f]+)\t([\s\S]+)$/u.exec(record);
    if (!match) throw new Error("Git returned an invalid tree record");
    entries.set(match[3], { mode: Number.parseInt(match[1], 8), oid: match[2] });
  }
  return entries;
}

async function readIndexEntries(root: string): Promise<Map<string, GitEntry>> {
  const output = await gitBuffer(root, ["ls-files", "--stage", "-z"]);
  const entries = new Map<string, GitEntry>();
  for (const record of nulPaths(output)) {
    const match = /^(\d+) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/u.exec(record);
    if (!match) throw new Error("Git returned an invalid index record");
    const stage = Number(match[3]);
    if (stage !== 0) throw new Error(`workspace has an unmerged index entry: ${match[4]}`);
    entries.set(match[4], { mode: Number.parseInt(match[1], 8), oid: match[2], stage });
  }
  return entries;
}

function requireBlob(blobs: Map<string, WorkspaceBlob>, layer: WorkspaceLayer, path: string, oid?: string): WorkspaceBlob {
  const blob = blobs.get(blobKey(layer, path));
  if (!blob || !oid || blob.oid !== oid) throw new Error(`capsule ${layer} blob is missing or mismatched: ${path}`);
  return blob;
}

function blobKey(layer: WorkspaceLayer, path: string): string {
  return `${layer}\0${path}`;
}

function blobIdentity(blob: WorkspaceBlob): Pick<WorkspaceBlob, "layer" | "path" | "mode" | "oid"> {
  return { layer: blob.layer, path: blob.path, mode: blob.mode, oid: blob.oid };
}

function compareBlobIdentity(left: ReturnType<typeof blobIdentity>, right: ReturnType<typeof blobIdentity>): number {
  return left.layer.localeCompare(right.layer, "en") || left.path.localeCompare(right.path, "en");
}

function destinationPath(root: string, path: string): string {
  requireLogicalPath(path);
  const destination = resolve(root, ...path.split("/"));
  if (!destination.startsWith(`${root}${sep}`)) throw new Error("workspace path escapes its root");
  return destination;
}

function requireLogicalPath(path: string): void {
  if (path.length === 0 || path.includes("\0") || path.includes("\\") || path.startsWith("/") ||
      path.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("unsafe workspace path");
  }
}

function filesystemMode(gitMode: number): number {
  return gitMode === 0o100755 ? 0o755 : 0o644;
}

function safeSymlinkTarget(root: string, destination: string, bytes: Uint8Array): string {
  const target = new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(bytes);
  const resolved = resolve(dirname(destination), target);
  if (target.length === 0 || target.includes("\0") || isAbsolute(target) || resolved === root || !resolved.startsWith(`${root}${sep}`)) {
    throw new Error("workspace symlink target escapes its root");
  }
  return target;
}

async function restoreIndex(path: string, bytes: Uint8Array | undefined): Promise<void> {
  if (!bytes) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function acquireWorkspaceBaseline(inspection: BaselineInspection): Promise<BaselineChange> {
  const change: BaselineChange = {
    root: inspection.root,
    changed: false,
    originalCommit: inspection.currentCommit,
    originalRef: inspection.currentRef,
  };
  if (!inspection.checkout || !inspection.baseCommit) return change;
  if (inspection.fetch) {
    await fetchWorkspaceBaseline(inspection.root, inspection.baseCommit);
    if (!await gitObjectExists(inspection.root, inspection.baseCommit)) {
      throw new WorkspaceBaselineUnavailable(inspection.baseCommit, "fetch-failed");
    }
  }
  try {
    await gitText(inspection.root, ["checkout", "--quiet", "--detach", inspection.baseCommit]);
    change.changed = true;
    return change;
  } catch {
    await rollbackWorkspaceBaseline({ ...change, changed: true }).catch(() => undefined);
    throw new WorkspaceBaselineUnavailable(inspection.baseCommit, "checkout-failed");
  }
}

async function rollbackWorkspaceBaseline(change: BaselineChange): Promise<void> {
  if (!change.changed) return;
  if (change.originalCommit) {
    if (change.originalRef) await gitText(change.root, ["checkout", "--quiet", change.originalRef]);
    else await gitText(change.root, ["checkout", "--quiet", "--detach", change.originalCommit]);
    return;
  }
  if (!change.originalRef) throw new Error("cannot restore an unborn workspace without its original branch");
  const tracked = nulPaths(await gitBuffer(change.root, ["ls-files", "-z"]));
  await gitText(change.root, ["read-tree", "--empty"]);
  for (const path of tracked) await rm(destinationPath(change.root, path), { force: true });
  await gitText(change.root, ["symbolic-ref", "HEAD", `refs/heads/${change.originalRef}`]);
}

async function fetchWorkspaceBaseline(root: string, baseCommit: string): Promise<void> {
  const environment = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  const execute = (args: string[]) => run("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: environment,
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: GIT_FETCH_TIMEOUT_MS,
    killSignal: "SIGKILL",
  }).then(() => true, () => false);
  if (await execute(["fetch", "--no-tags", "--no-write-fetch-head", "origin", baseCommit])) return;
  const shallow = (await gitText(root, ["rev-parse", "--is-shallow-repository"]).catch(() => "false")).trim() === "true";
  const fetched = shallow
    ? await execute(["fetch", "--no-tags", "--unshallow", "origin"])
    : await execute(["fetch", "--no-tags", "origin"]);
  if (!fetched || !await gitObjectExists(root, baseCommit)) {
    throw new WorkspaceBaselineUnavailable(baseCommit, "fetch-failed");
  }
}

async function gitObjectExists(root: string, commit: string): Promise<boolean> {
  return gitText(root, ["cat-file", "-e", `${commit}^{commit}`]).then(() => true, () => false);
}

async function hasOrigin(root: string): Promise<boolean> {
  return gitText(root, ["remote", "get-url", "origin"]).then((value) => value.trim().length > 0, () => false);
}

function baselineUnavailableMessage(reason: WorkspaceBaselineUnavailable["reason"]): string {
  const guidance: Record<WorkspaceBaselineUnavailable["reason"], string> = {
    "approval-required": "operator approval is required before Statecase may fetch it; fetch it with system Git or reattach this workspace with --git-fetch auto",
    "policy-disabled": "automatic Git fetch is disabled; provision the commit with system Git or change this workspace's fetch policy",
    "no-origin": "no origin is configured; provision the commit locally or configure a device-local Git origin",
    "fetch-failed": "system Git could not obtain it; verify this device's Git credentials and remote availability",
    "checkout-failed": "system Git obtained it but could not check it out safely",
    "unborn-mismatch": "an unborn capsule cannot replace a repository that already has a commit",
  };
  return `BASELINE_UNAVAILABLE: workspace baseline does not match the capsule; ${guidance[reason]}`;
}

async function gitText(root: string, args: string[]): Promise<string> {
  return (await run("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT })).stdout;
}

async function gitBuffer(root: string, args: string[]): Promise<Buffer> {
  return (await run("git", ["-C", root, ...args], {
    encoding: "buffer",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: MAX_GIT_OUTPUT,
  })).stdout;
}

function gitInput(root: string, args: string[], input: Uint8Array): Promise<Buffer> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("git", ["-C", root, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_GIT_OUTPUT) fail(new Error("Git output exceeded the workspace safety limit"));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_GIT_OUTPUT) fail(new Error("Git output exceeded the workspace safety limit"));
      else stderr.push(chunk);
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolveOutput(Buffer.concat(stdout));
      else reject(new Error(`Git command failed safely (${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
    child.stdin.end(Buffer.from(input));
  });
}

function nulPaths(value: Uint8Array): string[] {
  return Buffer.from(value).toString("utf8").split("\0").filter(Boolean);
}
