import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readlink, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_CAPSULE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_CAPSULE_RECORDS = 100_000;
const MAX_LFS_POINTER_BYTES = 16 * 1024;
const GIT_FETCH_TIMEOUT_MS = 60_000;
const GIT_LFS_TIMEOUT_MS = 5 * 60_000;
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

export class GitLfsContentUnavailable extends Error {
  readonly code = "GIT_LFS_CONTENT_UNAVAILABLE" as const;

  constructor(
    readonly paths: string[],
    readonly reason: "pointer" | "missing" | "checkout-filter" | "binary-missing" | "no-origin" | "download-failed" | "integrity",
  ) {
    const sample = paths.slice(0, 3).join(", ");
    const suffix = sample ? `: ${sample}${paths.length > 3 ? ` (+${paths.length - 3} more)` : ""}` : "";
    const guidance = {
      pointer: "materialize it with device-local Git LFS, reattach with --git-fetch auto, or use metadata-only",
      missing: "materialize it with device-local Git LFS, reattach with --git-fetch auto, or use metadata-only",
      "checkout-filter": "verify the device-local Git LFS filter and credentials or use metadata-only",
      "binary-missing": "install Git LFS on this device or use metadata-only",
      "no-origin": "configure a device-local origin, materialize it manually, or use metadata-only",
      "download-failed": "verify this device's Git LFS credentials and remote availability or use metadata-only",
      integrity: "the materialized bytes failed Git LFS size or SHA-256 verification",
    } satisfies Record<GitLfsContentUnavailable["reason"], string>;
    super(`GIT_LFS_CONTENT_UNAVAILABLE: Git LFS content is not available on this device (${reason}); ${guidance[reason]}${suffix}`);
    this.name = "GitLfsContentUnavailable";
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
  (transaction: WorkspaceFileTransaction): Promise<void>;
}

export type WorkspaceMaterializedWrite = { path: string; mode?: number } & (
  | { bytes: Uint8Array; sourcePath?: never }
  | { bytes?: never; sourcePath: string }
);

export interface WorkspaceApplication {
  root: string;
  captured: CapturedWorkspace;
  gitFetch?: GitFetchPolicy;
  /** Authenticated last-applied state, not a newly captured permission to overwrite. */
  expectedCurrent?: CapturedWorkspace;
}

export interface WorkspaceFileTransaction {
  writes: WorkspaceMaterializedWrite[];
  symlinks?: Array<{ path: string; target: string }>;
  deletes: string[];
  /** Materializers must run this guard immediately before replacing each target. */
  beforeCommit?: (index: number, path: string) => void | Promise<void>;
}

export interface WorkspaceReplacementPlan {
  paths: string[];
  targetHeadRef: string | null;
}

interface GitEntry {
  mode: number;
  oid: string;
  stage?: number;
}

export async function captureWorkspace(
  rootValue: string,
  options: { gitFetch?: GitFetchPolicy } = {},
): Promise<CapturedWorkspace> {
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
  const captured = { capsule: { schemaVersion: 1 as const, baseCommit, headRef, records }, blobs };
  await materializeGitLfs(root, baseCommit, captured, options.gitFetch ?? "ask");
  return captured;
}

export async function applyWorkspaceCapsule(
  rootValue: string,
  captured: CapturedWorkspace,
  options: { materialize: WorkspaceMaterializer; gitFetch?: GitFetchPolicy },
): Promise<void> {
  await applyWorkspaceTransaction([{ root: rootValue, captured, gitFetch: options.gitFetch }], { writes: [], deletes: [] }, options);
}

/**
 * Explicitly replaces a dirty workspace with an authenticated capsule.
 * The caller must durably capture every planned path plus Git HEAD/index state
 * in beforeMutation; no worktree, index, or ref mutation occurs before it
 * resolves successfully.
 */
export async function replaceWorkspaceCapsule(
  rootValue: string,
  captured: CapturedWorkspace,
  options: {
    materialize: WorkspaceMaterializer;
    beforeMutation: (plan: WorkspaceReplacementPlan) => Promise<void>;
    gitFetch?: GitFetchPolicy;
  },
): Promise<void> {
  const root = resolve(rootValue);
  const policy = options.gitFetch ?? "ask";
  const inspection = await inspectWorkspaceReplacement(root, captured, policy);
  if (inspection.fetch && inspection.baseCommit) {
    await fetchWorkspaceBaseline(root, inspection.baseCommit);
    if (!await gitObjectExists(root, inspection.baseCommit)) {
      throw new WorkspaceBaselineUnavailable(inspection.baseCommit, "fetch-failed");
    }
  }
  const logicalPaths = await workspaceReplacementPaths(root, captured, inspection.currentCommit);
  await assertNoInitializedSubmodule(root, captured);
  const paths = logicalPaths.map((path) => destinationPath(root, path));
  for (const [index, path] of paths.entries()) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (info?.isDirectory()) throw new Error(`workspace replacement refuses a directory target: ${logicalPaths[index]}`);
    if (info && !info.isFile() && !info.isSymbolicLink()) throw new Error(`unsupported workspace entry: ${logicalPaths[index]}`);
  }
  await options.beforeMutation({ paths, targetHeadRef: captured.capsule.headRef });

  await options.materialize({ writes: [], symlinks: [], deletes: paths });
  await removeEmptyWorkspaceParents(root, paths);
  if (captured.capsule.baseCommit) {
    try {
      await gitCheckoutText(root, ["read-tree", "--reset", "-u", captured.capsule.baseCommit]);
    } catch (error) {
      if (gitLfsFilterFailure(error)) {
        throw new GitLfsContentUnavailable(
          (await findGitLfsPointers(root, captured.capsule.baseCommit)).map((pointer) => pointer.path),
          "checkout-filter",
        );
      }
      throw new WorkspaceBaselineUnavailable(captured.capsule.baseCommit, "checkout-failed");
    }
  } else {
    await gitText(root, ["read-tree", "--empty"]);
  }
  await setWorkspaceHead(root, captured.capsule.baseCommit, captured.capsule.headRef);
  await materializeGitLfs(root, captured.capsule.baseCommit, captured, policy);

  const blobMap = new Map(captured.blobs.map((blob) => [blobKey(blob.layer, blob.path), blob]));
  for (const record of captured.capsule.records) await applyIndexRecord(root, record, blobMap);
  await options.materialize(workspaceOverlayTransaction(root, captured, blobMap));
}

/** Validates an explicit replacement without fetching or mutating the repository. */
export async function assertWorkspaceReplacement(
  rootValue: string,
  captured: CapturedWorkspace,
  options: { gitFetch?: GitFetchPolicy } = {},
): Promise<void> {
  const root = resolve(rootValue);
  await inspectWorkspaceReplacement(root, captured, options.gitFetch ?? "ask");
  await assertNoInitializedSubmodule(root, captured);
}

/** Applies ordinary files and one or more Git overlays as one filesystem revision. */
export async function applyWorkspaceTransaction(
  applications: readonly WorkspaceApplication[],
  initial: WorkspaceFileTransaction,
  options: { materialize: WorkspaceMaterializer },
): Promise<void> {
  const roots = applications.map((application) => resolve(application.root));
  if (new Set(roots).size !== roots.length) throw new Error("duplicate workspace transaction root");
  if (applications.some((application) => application.expectedCurrent)) {
    await applyManagedWorkspaceTransaction(applications, initial, options.materialize);
    return;
  }
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
    for (const [index, workspace] of prepared.entries()) {
      const change = baselineChanges[index]!;
      if (change.originalCommit === workspace.captured.capsule.baseCommit &&
          change.originalRef === workspace.captured.capsule.headRef) continue;
      change.changed = true;
      await setWorkspaceHead(workspace.root, workspace.captured.capsule.baseCommit, workspace.captured.capsule.headRef);
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

/** Preflight for a managed advance; never treats arbitrary dirty state as permission. */
export async function assertWorkspaceAdvance(
  rootValue: string,
  captured: CapturedWorkspace,
  expectedCurrent: CapturedWorkspace,
  gitFetch: GitFetchPolicy = "ask",
): Promise<void> {
  const root = resolve(rootValue);
  validateCaptured(expectedCurrent);
  if (!await workspaceMatchesCapsule(root, expectedCurrent)) throw new Error("workspace changed since its applied capsule");
  if (captured.capsule.baseCommit !== expectedCurrent.capsule.baseCommit && gitFetch !== "auto") {
    throw new WorkspaceBaselineUnavailable(captured.capsule.baseCommit, gitFetch === "ask" ? "approval-required" : "policy-disabled");
  }
  await assertWorkspaceReplacement(root, captured, { gitFetch });
}

/**
 * Build the new index separately and include it in the same file transaction as
 * worktree/session writes. No checkout/reset -u touches the old dirty worktree.
 */
async function applyManagedWorkspaceTransaction(
  applications: readonly WorkspaceApplication[],
  initial: WorkspaceFileTransaction,
  materialize: WorkspaceMaterializer,
): Promise<void> {
  const releaseIndexLocks: Array<() => Promise<void>> = [];
  const targetFingerprints = new Map<string, string>();
  const prepared: Array<{
    root: string; captured: CapturedWorkspace; current: CapturedWorkspace;
    indexPath: string; directory: string; stagedIndex: string;
    targetOriginalCommit: string | null; headChanged: boolean; targetRefChanged: boolean;
  }> = [];
  const transaction: WorkspaceFileTransaction = {
    writes: [...initial.writes], symlinks: [...(initial.symlinks ?? [])], deletes: [...initial.deletes],
    beforeCommit: async (index, path) => {
      await initial.beforeCommit?.(index, path);
      const expected = targetFingerprints.get(path);
      if (expected !== undefined && await workspaceTargetFingerprint(path) !== expected) {
        throw new Error("managed workspace target changed before commit");
      }
    },
  };
  try {
    // Preflight every root before even acquiring a missing object baseline.
    for (const application of applications) {
      if (application.expectedCurrent) await assertWorkspaceAdvance(application.root, application.captured, application.expectedCurrent, application.gitFetch);
      else await inspectWorkspaceDestination(application.root, application.captured, application.gitFetch);
    }
    for (const application of applications) {
      const root = resolve(application.root);
      const current = application.expectedCurrent ?? await captureWorkspace(root);
      const target = application.captured;
      if (target.capsule.baseCommit && !await gitObjectExists(root, target.capsule.baseCommit)) {
        await fetchWorkspaceBaseline(root, target.capsule.baseCommit);
      }
      await assertNoInitializedSubmodule(root, target);
      const indexValue = (await gitText(root, ["rev-parse", "--git-path", "index"])).trim();
      const indexPath = isAbsolute(indexValue) ? indexValue : resolve(root, indexValue);
      releaseIndexLocks.push(await acquireWorkspaceIndexLock(indexPath));
      const targetOriginalCommit = target.capsule.headRef
        ? await gitText(root, ["rev-parse", "--verify", `refs/heads/${target.capsule.headRef}`]).then((value) => value.trim(), () => null)
        : null;
      const directory = await mkdtemp(join(tmpdir(), "statecase-workspace-index-"));
      const stagedIndex = join(directory, "index");
      prepared.push({ root, captured: target, current, indexPath, directory, stagedIndex, targetOriginalCommit, headChanged: false, targetRefChanged: false });
      const environment = { GIT_INDEX_FILE: stagedIndex };
      await gitText(root, target.capsule.baseCommit ? ["read-tree", target.capsule.baseCommit] : ["read-tree", "--empty"], environment);
      const blobs = new Map(target.blobs.map((blob) => [blobKey(blob.layer, blob.path), blob]));
      for (const record of target.capsule.records) await applyIndexRecord(root, record, blobs, environment);
      const oldHead = current.capsule.baseCommit ? await readHeadEntries(root, current.capsule.baseCommit) : new Map<string, GitEntry>();
      const newHead = target.capsule.baseCommit ? await readHeadEntries(root, target.capsule.baseCommit) : new Map<string, GitEntry>();
      const records = new Map(target.capsule.records.map((record) => [record.path, record]));
      const oldRecords = new Set(current.capsule.records.map((record) => record.path));
      const paths = new Set([...oldRecords, ...records.keys()]);
      for (const path of new Set([...oldHead.keys(), ...newHead.keys()])) {
        const before = oldHead.get(path), after = newHead.get(path);
        if (before?.oid !== after?.oid || before?.mode !== after?.mode) paths.add(path);
      }
      for (const path of paths) {
        const destination = destinationPath(root, path);
        const info = await lstat(destination).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        if (info && !info.isFile() && !info.isSymbolicLink()) throw new Error("managed workspace refuses a non-file destination");
        if (info && !oldRecords.has(path) && !oldHead.has(path)) throw new Error("managed workspace destination contains unobserved local content");
        const record = records.get(path);
        if (record?.worktree.state === "submodule" || (!record && newHead.get(path)?.mode === 0o160000)) continue;
        targetFingerprints.set(destination, await workspaceTargetFingerprint(destination));
        let blob: { bytes: Uint8Array; mode: number } | undefined;
        if (record?.worktree.state === "content") blob = requireBlob(blobs, "worktree", path, record.worktree.oid);
        else if (record?.worktree.state === "index" && record.index.state === "content") blob = requireBlob(blobs, "index", path, record.index.oid);
        else if (record?.worktree.state !== "absent") {
          const entry = newHead.get(path);
          if (entry) {
            const size = Number((await gitText(root, ["cat-file", "-s", entry.oid])).trim());
            if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new Error("managed baseline blob exceeds safety limit");
            const bytes = new Uint8Array(await gitBuffer(root, ["cat-file", "blob", entry.oid]));
            // Never mistake an LFS pointer for the file. Existing materialized
            // bytes may satisfy it; otherwise explicit acquisition is required.
            const pointer = parseLfsPointer(bytes);
            if (pointer) {
              if (!info?.isFile() || info.size !== pointer.size || await sha256File(destination) !== pointer.oid) {
                throw new GitLfsContentUnavailable([path], "missing");
              }
              blob = { bytes: new Uint8Array(await readFile(destination)), mode: entry.mode };
            } else blob = { bytes, mode: entry.mode };
          }
        }
        if (!blob) transaction.deletes.push(destination);
        else if (blob.mode === 0o120000) transaction.symlinks!.push({ path: destination, target: safeSymlinkTarget(root, destination, blob.bytes) });
        else transaction.writes.push({ path: destination, bytes: blob.bytes, mode: filesystemMode(blob.mode) });
      }
      transaction.writes.push({ path: indexPath, bytes: new Uint8Array(await readFile(stagedIndex)), mode: 0o600 });
    }
    // Staging may take time. Never use the earlier equality check as authority
    // after an editor/Git process has changed the source while preparing it.
    for (const workspace of prepared) {
      if (!await workspaceMatchesCapsule(workspace.root, workspace.current)) throw new Error("managed workspace changed during preparation");
      await assertWorkspaceHeadReference(workspace.root, workspace.captured);
      targetFingerprints.set(workspace.indexPath, await workspaceTargetFingerprint(workspace.indexPath));
    }
    for (const workspace of prepared) {
      if (workspace.current.capsule.baseCommit === workspace.captured.capsule.baseCommit &&
          workspace.current.capsule.headRef === workspace.captured.capsule.headRef) continue;
      const target = workspace.captured.capsule;
      if (target.headRef !== null) {
        await compareAndSwapWorkspaceRef(workspace.root, `refs/heads/${target.headRef}`, target.baseCommit, workspace.targetOriginalCommit);
        workspace.targetRefChanged = target.baseCommit !== workspace.targetOriginalCommit;
      }
      // Switching HEAD must not also rewrite the branch we are leaving.
      await setWorkspaceHeadIdentity(workspace.root, target.baseCommit, target.headRef);
      workspace.headChanged = true;
    }
    await materialize(transaction);
  } catch (cause) {
    const failures: unknown[] = [];
    for (const workspace of [...prepared].reverse()) {
      if (!workspace.headChanged && !workspace.targetRefChanged) continue;
      try {
        // A rollback may revert our write, never a newer independent Git write.
        // Keep the current HEAD untouched when another process has selected or
        // advanced it, and surface incomplete recovery instead of clobbering it.
        if (workspace.headChanged) {
          const headRef = await gitText(workspace.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((value) => value.trim(), () => null);
          const commit = await gitText(workspace.root, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim(), () => null);
          if (headRef !== workspace.captured.capsule.headRef || commit !== workspace.captured.capsule.baseCommit) {
            throw new Error("managed workspace HEAD advanced independently; refusing rollback");
          }
        }
        const targetRef = workspace.captured.capsule.headRef;
        if (targetRef !== null && workspace.targetRefChanged) {
          await compareAndSwapWorkspaceRef(workspace.root, `refs/heads/${targetRef}`, workspace.targetOriginalCommit, workspace.captured.capsule.baseCommit);
        }
        if (workspace.headChanged) await setWorkspaceHeadIdentity(workspace.root, workspace.current.capsule.baseCommit, workspace.current.capsule.headRef);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError([cause, ...failures], "managed workspace reference rollback failed");
    throw cause;
  } finally {
    await Promise.all([
      ...prepared.map((workspace) => rm(workspace.directory, { recursive: true, force: true })),
      ...releaseIndexLocks.map((release) => release()),
    ]);
  }
}

/** Compare-and-swap even for deletion/creation; never dereference a branch alias. */
async function compareAndSwapWorkspaceRef(root: string, ref: string, replacement: string | null, expected: string | null): Promise<void> {
  if (replacement === null && expected === null) {
    await gitInput(root, ["update-ref", "--no-deref", "--stdin"], new TextEncoder().encode(`verify ${ref}\n`));
  } else {
    await gitText(root, ["update-ref", "--no-deref", ref, replacement ?? "0".repeat(expected!.length), expected ?? ""]);
  }
}

/** Change only HEAD identity; an original branch may have advanced independently. */
async function setWorkspaceHeadIdentity(root: string, baseCommit: string | null, headRef: string | null): Promise<void> {
  if (headRef !== null) await gitText(root, ["symbolic-ref", "HEAD", `refs/heads/${headRef}`]);
  else {
    if (!baseCommit) throw new Error("an unborn workspace requires a symbolic head reference");
    await gitText(root, ["update-ref", "--no-deref", "HEAD", baseCommit]);
  }
}

async function workspaceTargetFingerprint(path: string): Promise<string> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!info) return "absent";
  if (!info.isFile() && !info.isSymbolicLink()) throw new Error("managed workspace target changed to a non-file");
  const content = info.isSymbolicLink() ? await readlink(path) : await sha256File(path);
  return JSON.stringify([info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs, content]);
}

/** Respect Git's writer exclusion without breaking or stealing an existing lock. */
async function acquireWorkspaceIndexLock(indexPath: string): Promise<() => Promise<void>> {
  const lockPath = `${indexPath}.lock`;
  const handle = await open(lockPath, "wx", 0o600);
  const identity = await handle.stat();
  return async () => {
    try {
      const current = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (current && current.dev === identity.dev && current.ino === identity.ino) await rm(lockPath);
    } finally { await handle.close(); }
  };
}

interface BaselineInspection {
  root: string;
  captured: CapturedWorkspace;
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
  targetRef: string | null;
  originalTargetCommit: string | null;
  introducedPaths: string[];
  lfsOriginals: LfsOriginal[];
}

interface GitLfsPointer {
  path: string;
  oid: string;
  size: number;
}

interface LfsOriginal {
  path: string;
  bytes?: Uint8Array;
  mode?: number;
}

interface GitLfsIssue extends GitLfsPointer {
  reason: "pointer" | "missing" | "integrity";
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
  await assertWorkspaceHeadReference(root, captured);
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
    const issues = currentBase ? await gitLfsIssues(root, currentBase, captured) : [];
    if (issues.length > 0 && gitFetch !== "auto") throwGitLfsIssues(issues);
    return { root, captured, baseCommit: captured.capsule.baseCommit, currentCommit: currentBase, currentRef, fetch: false, checkout: false };
  }
  if (gitFetch !== "auto") {
    throw new WorkspaceBaselineUnavailable(captured.capsule.baseCommit, gitFetch === "ask" ? "approval-required" : "policy-disabled");
  }
  if (!captured.capsule.baseCommit) throw new WorkspaceBaselineUnavailable(null, "unborn-mismatch");
  const present = await gitObjectExists(root, captured.capsule.baseCommit);
  if (!present && !await hasOrigin(root)) throw new WorkspaceBaselineUnavailable(captured.capsule.baseCommit, "no-origin");
  return { root, captured, baseCommit: captured.capsule.baseCommit, currentCommit: currentBase, currentRef, fetch: !present, checkout: true };
}

async function inspectWorkspaceReplacement(
  root: string,
  captured: CapturedWorkspace,
  gitFetch: GitFetchPolicy,
): Promise<BaselineInspection> {
  validateCaptured(captured);
  if ((await gitText(root, ["rev-parse", "--is-inside-work-tree"]).catch(() => "false")).trim() !== "true") {
    throw new Error(`workspace is not a Git working tree: ${root}`);
  }
  await assertWorkspaceHeadReference(root, captured);
  for (const blob of captured.blobs) {
    const oid = (await gitInput(root, ["hash-object", "--stdin"], blob.bytes)).toString("utf8").trim();
    if (oid !== blob.oid) throw new Error(`workspace blob digest does not match: ${blob.path}`);
    if (blob.mode === 0o120000) safeSymlinkTarget(root, destinationPath(root, blob.path), blob.bytes);
  }
  const currentCommit = await gitText(root, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim(), () => null);
  const currentRef = await gitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((value) => value.trim(), () => null);
  const baseCommit = captured.capsule.baseCommit;
  if (baseCommit === null) {
    return { root, captured, baseCommit, currentCommit, currentRef, fetch: false, checkout: currentCommit !== null };
  }
  const present = await gitObjectExists(root, baseCommit);
  if (!present && gitFetch !== "auto") {
    throw new WorkspaceBaselineUnavailable(baseCommit, gitFetch === "ask" ? "approval-required" : "policy-disabled");
  }
  if (!present && !await hasOrigin(root)) throw new WorkspaceBaselineUnavailable(baseCommit, "no-origin");
  if (present) {
    const issues = await gitLfsIssues(root, baseCommit, captured);
    if (issues.length > 0 && gitFetch !== "auto") throwGitLfsIssues(issues);
  }
  return { root, captured, baseCommit, currentCommit, currentRef, fetch: !present, checkout: currentCommit !== baseCommit };
}

async function assertTargetRefNotCheckedOutElsewhere(root: string, headRef: string): Promise<void> {
  const targetRef = `refs/heads/${headRef}`;
  const fields = nulPaths(await gitBuffer(root, ["worktree", "list", "--porcelain", "-z"]));
  let worktree: string | undefined;
  for (const field of fields) {
    if (field.startsWith("worktree ")) worktree = field.slice("worktree ".length);
    else if (field === `branch ${targetRef}` && worktree && resolve(worktree) !== root) {
      throw new Error(`workspace target branch is checked out in another worktree: ${headRef}`);
    }
  }
}

async function assertWorkspaceHeadReference(root: string, captured: CapturedWorkspace): Promise<void> {
  if (captured.capsule.headRef !== null) {
    if (captured.capsule.headRef.startsWith("refs/")) throw new Error("invalid workspace head reference");
    await gitText(root, ["check-ref-format", "--branch", captured.capsule.headRef]).catch(() => {
      throw new Error("invalid workspace head reference");
    });
    await assertTargetRefNotCheckedOutElsewhere(root, captured.capsule.headRef);
  } else if (captured.capsule.baseCommit === null) {
    throw new Error("an unborn workspace requires a symbolic head reference");
  }
}

async function workspaceReplacementPaths(
  root: string,
  captured: CapturedWorkspace,
  currentCommit: string | null,
): Promise<string[]> {
  const changed = new Set<string>(captured.capsule.records.map((record) => record.path));
  const localChanges = await Promise.all([
    gitBuffer(root, ["diff", "--name-only", "-z"]),
    gitBuffer(root, ["diff", "--cached", "--name-only", "-z"]),
    gitBuffer(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  for (const output of localChanges) for (const path of nulPaths(output)) changed.add(path);
  const targetCommit = captured.capsule.baseCommit;
  if (currentCommit && targetCommit) {
    for (const path of nulPaths(await gitBuffer(root, ["diff", "--no-renames", "--name-only", "-z", currentCommit, targetCommit, "--"]))) changed.add(path);
  } else if (currentCommit) {
    for (const path of (await readHeadEntries(root, currentCommit)).keys()) changed.add(path);
  } else if (targetCommit) {
    for (const path of (await readHeadEntries(root, targetCommit)).keys()) changed.add(path);
  }
  for (const path of changed) requireLogicalPath(path);
  return [...changed].sort((left, right) => left.localeCompare(right, "en"));
}

async function assertNoInitializedSubmodule(root: string, captured: CapturedWorkspace): Promise<void> {
  const paths = new Set<string>();
  for (const [path, entry] of await readIndexEntries(root)) if (entry.mode === 0o160000) paths.add(path);
  if (captured.capsule.baseCommit) {
    for (const [path, entry] of await readHeadEntries(root, captured.capsule.baseCommit)) if (entry.mode === 0o160000) paths.add(path);
  }
  for (const record of captured.capsule.records) if (record.index.state === "submodule") paths.add(record.path);
  for (const path of paths) {
    const info = await lstat(destinationPath(root, path)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (info?.isDirectory()) throw new Error(`initialized submodule worktrees are not supported: ${path}`);
  }
}

async function removeEmptyWorkspaceParents(root: string, paths: readonly string[]): Promise<void> {
  const parents = new Set<string>();
  for (const path of paths) {
    let parent = dirname(path);
    while (parent !== root) {
      parents.add(parent);
      parent = dirname(parent);
    }
  }
  for (const parent of [...parents].sort((left, right) => right.length - left.length)) {
    await rmdir(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    });
  }
}

async function setWorkspaceHead(root: string, baseCommit: string | null, headRef: string | null): Promise<void> {
  if (headRef !== null) {
    const fullRef = `refs/heads/${headRef}`;
    if (baseCommit) await gitText(root, ["update-ref", fullRef, baseCommit]);
    else await gitText(root, ["update-ref", "-d", fullRef]);
    await gitText(root, ["symbolic-ref", "HEAD", fullRef]);
    return;
  }
  if (!baseCommit) throw new Error("an unborn workspace requires a symbolic head reference");
  await gitText(root, ["update-ref", "--no-deref", "HEAD", baseCommit]);
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

async function applyIndexRecord(root: string, record: WorkspaceRecord, blobs: Map<string, WorkspaceBlob>, environment?: Record<string, string>): Promise<void> {
  if (record.index.state === "base") return;
  if (record.index.state === "absent") {
    await gitText(root, ["update-index", "--force-remove", "--", record.path], environment);
    return;
  }
  if (!record.index.oid || !record.index.mode) throw new Error(`capsule index metadata is incomplete: ${record.path}`);
  if (record.index.state === "content") {
    const blob = requireBlob(blobs, "index", record.path, record.index.oid);
    const oid = (await gitInput(root, ["hash-object", "-w", "--stdin"], blob.bytes)).toString("utf8").trim();
    if (oid !== record.index.oid) throw new Error(`capsule index blob digest mismatch: ${record.path}`);
  }
  await gitText(root, ["update-index", "--add", "--cacheinfo", record.index.mode.toString(8), record.index.oid, record.path], environment);
}

function workspaceOverlayTransaction(
  root: string,
  captured: CapturedWorkspace,
  blobs: Map<string, WorkspaceBlob>,
): WorkspaceFileTransaction {
  const transaction: WorkspaceFileTransaction = { writes: [], symlinks: [], deletes: [] };
  for (const record of captured.capsule.records) {
    const destination = destinationPath(root, record.path);
    if (record.worktree.state === "absent") {
      transaction.deletes.push(destination);
    } else if (record.worktree.state === "content") {
      const blob = requireBlob(blobs, "worktree", record.path, record.worktree.oid);
      if (blob.mode === 0o120000) transaction.symlinks!.push({ path: destination, target: safeSymlinkTarget(root, destination, blob.bytes) });
      else transaction.writes.push({ path: destination, bytes: blob.bytes, mode: filesystemMode(blob.mode) });
    } else if (record.worktree.state === "index" && record.index.state === "content") {
      const blob = requireBlob(blobs, "index", record.path, record.index.oid);
      if (blob.mode === 0o120000) transaction.symlinks!.push({ path: destination, target: safeSymlinkTarget(root, destination, blob.bytes) });
      else transaction.writes.push({ path: destination, bytes: blob.bytes, mode: filesystemMode(blob.mode) });
    }
  }
  return transaction;
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
  const targetRef = inspection.captured.capsule.headRef;
  const change: BaselineChange = {
    root: inspection.root,
    changed: false,
    originalCommit: inspection.currentCommit,
    originalRef: inspection.currentRef,
    targetRef,
    originalTargetCommit: targetRef === null
      ? null
      : await gitText(inspection.root, ["rev-parse", "--verify", `refs/heads/${targetRef}`]).then((value) => value.trim(), () => null),
    introducedPaths: [],
    lfsOriginals: [],
  };
  if (!inspection.baseCommit) return change;
  if (inspection.checkout) {
    if (inspection.fetch) {
      await fetchWorkspaceBaseline(inspection.root, inspection.baseCommit);
      if (!await gitObjectExists(inspection.root, inspection.baseCommit)) {
        throw new WorkspaceBaselineUnavailable(inspection.baseCommit, "fetch-failed");
      }
    }
    change.introducedPaths = await baselineIntroducedPaths(inspection.root, inspection.currentCommit, inspection.baseCommit);
    try {
      await gitCheckoutText(inspection.root, ["checkout", "--quiet", "--detach", inspection.baseCommit]);
      change.changed = true;
    } catch (error) {
      await rollbackWorkspaceBaseline({ ...change, changed: true }).catch(() => undefined);
      if (gitLfsFilterFailure(error)) {
        throw new GitLfsContentUnavailable((await findGitLfsPointers(inspection.root, inspection.baseCommit)).map((pointer) => pointer.path), "checkout-filter");
      }
      throw new WorkspaceBaselineUnavailable(inspection.baseCommit, "checkout-failed");
    }
  }
  try {
    const originals = await materializeGitLfs(inspection.root, inspection.baseCommit, inspection.captured, "auto");
    if (!inspection.checkout) change.lfsOriginals = originals;
    return change;
  } catch (error) {
    await rollbackWorkspaceBaseline(change);
    throw error;
  }
}

async function rollbackWorkspaceBaseline(change: BaselineChange): Promise<void> {
  if (change.changed) {
    if (change.targetRef) {
      const fullTargetRef = `refs/heads/${change.targetRef}`;
      if (change.originalTargetCommit) await gitText(change.root, ["update-ref", fullTargetRef, change.originalTargetCommit]);
      else await gitText(change.root, ["update-ref", "-d", fullTargetRef]);
    }
    if (change.originalCommit) {
      if (change.originalRef) await gitCheckoutText(change.root, ["checkout", "--quiet", "--force", change.originalRef]);
      else await gitCheckoutText(change.root, ["checkout", "--quiet", "--force", "--detach", change.originalCommit]);
    } else {
      if (!change.originalRef) throw new Error("cannot restore an unborn workspace without its original branch");
      await gitText(change.root, ["read-tree", "--empty"]);
      await gitText(change.root, ["symbolic-ref", "HEAD", `refs/heads/${change.originalRef}`]);
    }
    for (const path of change.introducedPaths) await removeIntroducedPath(change.root, path);
  }
  await restoreGitLfsOriginals(change.root, change.lfsOriginals);
}

async function baselineIntroducedPaths(root: string, originalCommit: string | null, baseCommit: string): Promise<string[]> {
  const candidates = originalCommit
    ? nulPaths(await gitBuffer(root, ["diff", "--no-renames", "--name-only", "--diff-filter=A", "-z", originalCommit, baseCommit, "--"]))
    : nulPaths(await gitBuffer(root, ["ls-tree", "-r", "--name-only", "-z", baseCommit]));
  const introduced: string[] = [];
  for (const path of candidates) {
    requireLogicalPath(path);
    const exists = await lstat(destinationPath(root, path)).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
    if (!exists) introduced.push(path);
  }
  return introduced;
}

async function removeIntroducedPath(root: string, path: string): Promise<void> {
  const destination = destinationPath(root, path);
  const info = await lstat(destination).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (info?.isDirectory()) await rmdir(destination);
  else if (info) await rm(destination, { force: true });
  let parent = dirname(destination);
  while (parent !== root) {
    const removed = await rmdir(parent).then(() => true, () => false);
    if (!removed) break;
    parent = dirname(parent);
  }
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

async function materializeGitLfs(
  root: string,
  baseCommit: string | null,
  captured: CapturedWorkspace,
  policy: GitFetchPolicy,
): Promise<LfsOriginal[]> {
  if (!baseCommit) return [];
  const issues = await gitLfsIssues(root, baseCommit, captured);
  if (issues.length === 0) return [];
  if (policy !== "auto") throwGitLfsIssues(issues);
  const paths = issues.map((issue) => issue.path);
  const originals = await captureGitLfsOriginals(root, paths);
  if (!await runGitLfs(root, ["version"])) {
    throw new GitLfsContentUnavailable(paths, "binary-missing");
  }
  let needsRefetch = false;
  if (await runGitLfs(root, ["checkout"])) {
    const local = await gitLfsIssues(root, baseCommit, captured, true);
    if (local.length === 0) return originals;
    needsRefetch = local.some((issue) => issue.reason === "integrity");
    await restoreGitLfsOriginals(root, originals);
  } else {
    await restoreGitLfsOriginals(root, originals);
  }
  if (!await hasOrigin(root)) throw new GitLfsContentUnavailable(paths, "no-origin");
  const fetchArguments = ["fetch", "--include=", "--exclude="];
  if (needsRefetch) fetchArguments.push("--refetch");
  fetchArguments.push("origin", baseCommit);
  if (!await runGitLfs(root, fetchArguments) || !await runGitLfs(root, ["checkout"])) {
    await restoreGitLfsOriginals(root, originals);
    throw new GitLfsContentUnavailable(paths, "download-failed");
  }
  const remaining = await gitLfsIssues(root, baseCommit, captured, true);
  if (remaining.length > 0) {
    await restoreGitLfsOriginals(root, originals);
    if (remaining.some((issue) => issue.reason === "integrity")) {
      throw new GitLfsContentUnavailable(remaining.map((issue) => issue.path), "integrity");
    }
    throw new GitLfsContentUnavailable(remaining.map((issue) => issue.path), "download-failed");
  }
  return originals;
}

async function gitLfsIssues(
  root: string,
  baseCommit: string,
  captured: CapturedWorkspace,
  verifyContent = false,
): Promise<GitLfsIssue[]> {
  const pointers = await findGitLfsPointers(root, baseCommit);
  const issues: GitLfsIssue[] = [];
  for (const pointer of pointers) {
    if (capsuleResolvesLfsPath(captured, pointer.path)) continue;
    const path = destinationPath(root, pointer.path);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!info || !info.isFile()) {
      issues.push({ ...pointer, reason: "missing" });
      continue;
    }
    if (info.size <= MAX_LFS_POINTER_BYTES && parseLfsPointer(new Uint8Array(await readFile(path)))) {
      issues.push({ ...pointer, reason: "pointer" });
      continue;
    }
    if (verifyContent && (info.size !== pointer.size || await sha256File(path) !== pointer.oid)) {
      issues.push({ ...pointer, reason: "integrity" });
    }
  }
  return issues;
}

function throwGitLfsIssues(issues: GitLfsIssue[]): never {
  const reason = issues.some((issue) => issue.reason === "integrity")
    ? "integrity"
    : issues.some((issue) => issue.reason === "missing") ? "missing" : "pointer";
  throw new GitLfsContentUnavailable(issues.map((issue) => issue.path), reason);
}

async function findGitLfsPointers(root: string, baseCommit: string): Promise<GitLfsPointer[]> {
  const output = await gitBufferAllowNoMatch(root, [
    "grep", "-l", "-z", "--no-textconv", "--no-ext-grep",
    "-e", "^version https://git-lfs.github.com/spec/v1$", baseCommit, "--",
  ]);
  const prefix = `${baseCommit}:`;
  const pointers: GitLfsPointer[] = [];
  for (const entry of nulPaths(output)) {
    if (!entry.startsWith(prefix)) throw new Error("Git returned an invalid LFS candidate path");
    const path = entry.slice(prefix.length);
    requireLogicalPath(path);
    const size = Number((await gitText(root, ["cat-file", "-s", `${baseCommit}:${path}`])).trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Git returned an invalid LFS candidate size");
    if (size > MAX_LFS_POINTER_BYTES) continue;
    const pointer = parseLfsPointer(new Uint8Array(await gitBuffer(root, ["cat-file", "blob", `${baseCommit}:${path}`])));
    if (pointer) pointers.push({ path, ...pointer });
  }
  if (pointers.length > MAX_CAPSULE_RECORDS) throw new Error("workspace has too many Git LFS pointers");
  return pointers.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function captureGitLfsOriginals(root: string, paths: string[]): Promise<LfsOriginal[]> {
  const originals: LfsOriginal[] = [];
  for (const path of paths) {
    const destination = destinationPath(root, path);
    const info = await lstat(destination).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!info) originals.push({ path });
    else if (info.isFile() && info.size <= MAX_LFS_POINTER_BYTES) {
      originals.push({ path, bytes: new Uint8Array(await readFile(destination)), mode: info.mode & 0o777 });
    } else {
      throw new GitLfsContentUnavailable([path], "integrity");
    }
  }
  return originals;
}

async function restoreGitLfsOriginals(root: string, originals: LfsOriginal[]): Promise<void> {
  for (const original of [...originals].reverse()) {
    const destination = destinationPath(root, original.path);
    if (!original.bytes) {
      await rm(destination, { force: true });
      continue;
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, original.bytes, { mode: original.mode ?? 0o600 });
    if (original.mode !== undefined) await chmod(destination, original.mode);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function runGitLfs(root: string, args: string[]): Promise<boolean> {
  return run("git", ["-C", root, "lfs", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_ATTR_SOURCE: "HEAD",
      GIT_LFS_SKIP_DOWNLOAD_ERRORS: "0",
      GIT_LFS_SKIP_SMUDGE: "0",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: GIT_LFS_TIMEOUT_MS,
    killSignal: "SIGKILL",
  }).then(() => true, () => false);
}

async function gitCheckoutText(root: string, args: string[]): Promise<string> {
  return (await run("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_LFS_SKIP_DOWNLOAD_ERRORS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: GIT_LFS_TIMEOUT_MS,
    killSignal: "SIGKILL",
  })).stdout;
}

function capsuleResolvesLfsPath(captured: CapturedWorkspace, path: string): boolean {
  const record = captured.capsule.records.find((candidate) => candidate.path === path);
  if (!record) return false;
  if (record.worktree.state === "absent") return true;
  const layer = record.worktree.state === "content"
    ? "worktree"
    : record.worktree.state === "index" && record.index.state === "content"
      ? "index"
      : undefined;
  if (!layer) return false;
  const blob = captured.blobs.find((candidate) => candidate.layer === layer && candidate.path === path);
  return Boolean(blob && !parseLfsPointer(blob.bytes));
}

function parseLfsPointer(bytes: Uint8Array): { oid: string; size: number } | null {
  if (bytes.byteLength > MAX_LFS_POINTER_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== "version https://git-lfs.github.com/spec/v1") return null;
  const oid = lines.find((line) => /^oid sha256:[0-9a-f]{64}$/u.test(line))?.slice("oid sha256:".length);
  const sizeText = lines.find((line) => /^size [0-9]+$/u.test(line))?.slice("size ".length);
  if (!oid || sizeText === undefined) return null;
  const size = Number(sizeText);
  return Number.isSafeInteger(size) && size >= 0 ? { oid, size } : null;
}

function gitLfsFilterFailure(error: unknown): boolean {
  const stderr = String((error as { stderr?: unknown })?.stderr).toLowerCase();
  return /git-lfs|lfs (?:filter|smudge)/u.test(stderr);
}

async function gitText(root: string, args: string[], environment?: Record<string, string>): Promise<string> {
  return (await run("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT, env: { ...process.env, ...environment } })).stdout;
}

async function gitBuffer(root: string, args: string[]): Promise<Buffer> {
  return (await run("git", ["-C", root, ...args], {
    encoding: "buffer",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: MAX_GIT_OUTPUT,
  })).stdout;
}

async function gitBufferAllowNoMatch(root: string, args: string[]): Promise<Buffer> {
  try {
    return await gitBuffer(root, args);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return Buffer.alloc(0);
    throw error;
  }
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
