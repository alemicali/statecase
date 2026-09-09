import type { BigIntStats } from "node:fs";
import { constants, link, lstat, mkdir, open, opendir, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const pathSchema = z.string().min(1).max(4096);
const identity = z.string().min(1).max(1024);
const parentSchema = z.object({ path: pathSchema, identity }).strict();
export const nativeLockSchema = z.object({ version: z.literal(1), id: z.uuid(), root: pathSchema, path: pathSchema,
  parents: z.array(parentSchema).min(1).max(64), artifact: parentSchema, anchorIdentity: identity }).strict();
export type NativeLockPlan = z.infer<typeof nativeLockSchema>;
export interface NativeLockOptions {
  /** Independently derived exact Git lock grants, never authority from the plan. */
  grants: ReadonlyArray<{ root: string; path: string }>;
  dryRun?: boolean;
  /** Internal fault boundaries; never CLI flags. */
  afterBoundary?: (phase: "link-created" | "link-durable" | "native-unlinked" | "anchor-unlinked" | "artifact-removed" | "released-durable") => void | Promise<void>;
}
export class NativeLockRecoveryError extends Error {
  readonly code = "NATIVE_LOCK_RECOVERY_REQUIRED";
  constructor() { super("native lock ownership cannot be verified; existing locks and recovery evidence preserved"); this.name = "NativeLockRecoveryError"; }
}
const fail = () => new NativeLockRecoveryError();
const anchorPath = (plan: NativeLockPlan) => join(plan.artifact.path, "anchor");
const marker = (id: string) => `STATECASE-NATIVE-LOCK/1\n${id}\n`;

/** Allocate a private, durable ownership anchor WITHOUT taking a native lock.
 * The outer coordinator MUST durably record the returned plan before acquire,
 * and hold its transaction mutex through acquisition, mutations and release.
 * The anchor is adjacent to the native path so publication is same-filesystem.
 */
export async function prepareNativeLock(path: string, options: NativeLockOptions): Promise<NativeLockPlan> {
  try {
    if (options.dryRun) throw fail();
    const root = grantedRoot(path, options), parents = await observeParents(root, path), id = crypto.randomUUID();
    const artifactPath = `${path}.statecase-transaction-${id}.staged`;
    await mkdir(artifactPath, { mode: 0o700 });
    const artifact = { path: artifactPath, identity: directoryIdentity(await lstat(artifactPath, { bigint: true })) };
    const handle = await open(join(artifactPath, "anchor"), "wx", 0o600);
    let anchorIdentity: string;
    try { await handle.writeFile(marker(id)); await handle.sync(); anchorIdentity = fileIdentity(await handle.stat({ bigint: true })); }
    finally { await handle.close(); }
    const plan: NativeLockPlan = { version: 1, id, root, path, parents, artifact, anchorIdentity };
    await syncDirectory(artifactPath); await syncDirectory(dirname(path));
    await inspect(plan, options);
    return plan;
  } catch { throw fail(); }
}

/** Only call after the plan is durable. No PID, mtime expiry or lock stealing. */
export async function acquireNativeLock(value: NativeLockPlan, options: NativeLockOptions): Promise<void> {
  try {
    if (options.dryRun) throw fail();
    const { plan, anchor, held } = await inspect(value, options);
    if (!anchor) throw fail();
    if (!held) {
      await link(anchorPath(plan), plan.path);
      await options.afterBoundary?.("link-created");
    }
    await inspect(plan, options);
    await syncDirectory(dirname(plan.path));
    await options.afterBoundary?.("link-durable");
  } catch { throw fail(); }
}

/** Recovery/cleanup of a proven owned lock. Preview never mutates. Repeating
 * after interruption between unlink/fsync/anchor retirement is safe. */
export async function releaseNativeLock(value: NativeLockPlan, options: NativeLockOptions): Promise<void> {
  try {
    const state = await inspect(value, options), { plan } = state;
    if (options.dryRun) return;
    if (state.held) {
      await inspect(plan, options);
      await rm(plan.path);
      await options.afterBoundary?.("native-unlinked");
      await syncDirectory(dirname(plan.path));
    }
    const current = await inspect(plan, options);
    if (current.held) throw fail();
    if (current.anchor) {
      await rm(anchorPath(plan));
      await options.afterBoundary?.("anchor-unlinked");
      await syncDirectory(plan.artifact.path);
    }
    const final = await inspect(plan, options);
    if (final.held || final.anchor) throw fail();
    if (final.artifact) {
      await rmdir(plan.artifact.path);
      await options.afterBoundary?.("artifact-removed");
    }
    // Replayed deletion may already be visible but not yet directory-durable.
    await syncDirectory(dirname(plan.path));
    await options.afterBoundary?.("released-durable");
  } catch { throw fail(); }
}

/** Observational mutation/replay barrier: never recreate a disappeared lock. */
export async function assertNativeLockHeld(value: NativeLockPlan, options: NativeLockOptions): Promise<void> {
  try { if (!(await inspect(value, options)).held) throw fail(); } catch { throw fail(); }
}

async function inspect(value: NativeLockPlan, options: NativeLockOptions) {
  const plan = nativeLockSchema.parse(value);
  if (grantedRoot(plan.path, options) !== plan.root || plan.artifact.path !== `${plan.path}.statecase-transaction-${plan.id}.staged`) throw fail();
  const parents = await observeParents(plan.root, plan.path);
  if (JSON.stringify(parents) !== JSON.stringify(plan.parents)) throw fail();
  const artifact = await optionalStat(plan.artifact.path);
  if (artifact) {
    if (!artifact.isDirectory() || directoryIdentity(artifact) !== plan.artifact.identity || (artifact.mode & 0o777n) !== 0o700n || !owner(artifact)) throw fail();
    const directory = await opendir(plan.artifact.path);
    for await (const entry of directory) if (entry.name !== "anchor") throw fail();
  }
  const anchor = artifact ? await ownedFile(anchorPath(plan), plan) : undefined;
  const held = await ownedFile(plan.path, plan);
  if ((!artifact && held) || (held && !anchor) || (anchor && anchor.nlink !== (held ? 2n : 1n))) throw fail();
  if (JSON.stringify(await observeParents(plan.root, plan.path)) !== JSON.stringify(plan.parents)) throw fail();
  return { plan, artifact, anchor, held };
}

async function ownedFile(path: string, plan: NativeLockPlan): Promise<BigIntStats | undefined> {
  const before = await optionalStat(path);
  if (!before) return undefined;
  if (!before.isFile() || !owner(before) || (before.mode & 0o777n) !== 0o600n || before.nlink < 1n || before.nlink > 2n ||
      fileIdentity(before) !== plan.anchorIdentity || before.size !== BigInt(Buffer.byteLength(marker(plan.id)))) throw fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(Number(before.size) + 1);
  try {
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== Number(before.size) || bytes.subarray(0, bytesRead).toString("utf8") !== marker(plan.id) ||
        fileObservation(await handle.stat({ bigint: true })) !== fileObservation(before) ||
        fileObservation(await lstat(path, { bigint: true })) !== fileObservation(before)) throw fail();
    return before;
  } finally { bytes.fill(0); await handle.close(); }
}

function grantedRoot(path: string, options: NativeLockOptions): string {
  if (!options.grants.length || options.grants.length > 128 || options.grants.some(grant => !canonical(grant.root) || !canonical(grant.path) ||
      !grant.path.endsWith(".lock") || !inside(grant.root, grant.path)) || new Set(options.grants.map(grant => grant.path)).size !== options.grants.length) throw fail();
  const grant = options.grants.find(grant => grant.path === path);
  if (!grant) throw fail();
  return grant.root;
}
async function observeParents(root: string, path: string): Promise<NativeLockPlan["parents"]> {
  const parts = relative(root, path).split(sep).slice(0, -1);
  if (parts.length >= 64) throw fail();
  const directories = [root, ...parts.map((_part, index) => join(root, ...parts.slice(0, index + 1)))];
  const parents = [];
  for (const path of directories) {
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory()) throw fail();
    parents.push({ path, identity: directoryIdentity(info) });
  }
  return parents;
}
function canonical(path: string) { return isAbsolute(path) && resolve(path) === path && path.length <= 4096 && ![...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }
function inside(root: string, path: string) { const child = relative(root, path); return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child); }
function owner(info: BigIntStats) { return !process.getuid || info.uid === BigInt(process.getuid()); }
function directoryIdentity(info: BigIntStats) { return [info.dev, info.ino, info.mode, info.uid].map(String).join(":"); }
function fileIdentity(info: BigIntStats) { return [info.dev, info.ino, info.mode, info.uid, info.size, info.mtimeNs].map(String).join(":"); }
function fileObservation(info: BigIntStats) { return `${fileIdentity(info)}:${info.nlink}:${info.ctimeNs}`; }
async function optionalStat(path: string) {
  try { return await lstat(path, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
