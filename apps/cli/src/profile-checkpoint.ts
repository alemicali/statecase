import { createHash } from "node:crypto";
import { lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@statecase/protocol";
import { z } from "zod";
import type { LocalConfig } from "./config.js";
import { decodeProfile, MAX_PROFILE_BYTES, ProfileFormatError } from "./profile-format.js";
import { applyRecoverableFileTransaction, recoverFileTransactions, type MaterializationRecoveryOptions, type MaterializationRecoveryResult } from "./materialization-recovery.js";
import type { FileTransaction } from "./materialize.js";
import { acquireNativeLock, assertNativeLockHeld, releaseNativeLock, type NativeLockOptions } from "./native-lock.js";
import { gitIndexFiles, gitIndexGrants, gitIndexSchema, gitMetadataExclusions, prepareGitIndexes, validateGitIndexes, type GitIndexParticipant } from "./git-index-participant.js";
import { assertNoGitGc, gitReferenceSchema, prepareGitReferences, retainPinOwnership, retireGitPins, validateGitReferences, type GitReferenceParticipant } from "./git-reference-participant.js";
import type { WorkspaceReferencePlan } from "@statecase/workspace";

const MAX_CHECKPOINT_BYTES = MAX_PROFILE_BYTES * 2 + 2 * 1024 * 1024;
const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const schema = z.object({ version: z.union([z.literal(1), z.literal(2), z.literal(3)]), id: z.uuid(), phase: z.enum(["prepared", "applying", "settled"]),
  original: z.string().max(MAX_PROFILE_BYTES), beforeHash: hash, afterHash: hash,
  gitIndexes: z.array(gitIndexSchema).max(32).optional(),
  gitReferences: gitReferenceSchema.optional(),
  settled: z.object({ outcome: z.enum(["rollback", "cleanup"]), profileHash: hash }).strict().optional() }).strict();
type Checkpoint = z.infer<typeof schema>;
export interface ProfileCheckpointIO {
  read(path: string, options?: { maximumBytes?: number; private?: boolean }): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
}
export interface ProfileCheckpointOptions {
  dryRun?: boolean;
  /** Internal prepared participants, restricted to original configured Git roots. */
  workspaceRoots?: readonly string[];
  workspaceReferences?: readonly WorkspaceReferencePlan[];
  beforeAdmission?: () => Promise<void>;
  afterBoundary?: (phase: Parameters<NonNullable<MaterializationRecoveryOptions["afterBoundary"]>>[0] |
    `native-${Parameters<NonNullable<NativeLockOptions["afterBoundary"]>>[0]}` |
    `reference-${Parameters<NonNullable<NativeLockOptions["afterBoundary"]>>[0]}` |
    "retention-removed" |
    "checkpoint-published" | "file-plan-published" | "checkpoint-applying" | "checkpoint-settled" | "files-finished", index: number) => void | Promise<void>;
}
type Roots = (config: LocalConfig) => string[];
const fail = () => new ProfileFormatError("PROFILE_RECOVERY_REQUIRED");
const checkpointPath = (home: string) => join(home, "profile-materialization.json");
const activePath = (home: string) => join(home, "materialization", "active.jsonl");
const profilePath = (home: string) => join(home, "config.json");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Validate the unchanged mapping/authority boundary before any Git acquisition. */
export function validateCheckpointTransition(before: string, after: string): LocalConfig {
  const original = decodeProfile(before), desired = decodeProfile(after);
  if (original.format !== 2 || desired.format !== 2 || invariantProfile(original.config) !== invariantProfile(desired.config)) throw fail();
  return original.config;
}

/** A pending checkpoint is never a usable partially updated local profile. */
export async function assertNoProfileCheckpoint(home: string): Promise<void> {
  if (await exists(checkpointPath(home)) || await exists(activePath(home))) throw fail();
}

/** Administrative stop-only metadata, not a sync/save observation. */
export async function serviceControlProfile(home: string, io: ProfileCheckpointIO): Promise<string | null> {
  const checkpoint = await readCheckpoint(home, io);
  return checkpoint?.value.original ?? await io.read(profilePath(home));
}

/** ConfigStore holds its config mutex for the whole operation. The only exact
 * metadata grant is config.json; callers may change applied/binding state only. */
export async function applyProfileCheckpoint(home: string, before: string, after: string, transaction: FileTransaction,
  roots: Roots, io: ProfileCheckpointIO, options: ProfileCheckpointOptions): Promise<void> {
  if (options.dryRun || transaction.lifecycle || transaction.finalWrites?.length) throw fail();
  await assertNoProfileCheckpoint(home);
  const original = { config: validateCheckpointTransition(before, after) };
  const gitIndexes = await prepareGitIndexes(original.config, options.workspaceRoots ?? []);
  const references = options.workspaceReferences?.length ? await prepareGitReferences(gitIndexes, options.workspaceReferences) : undefined;
  let checkpoint: Checkpoint = { version: references ? 3 : gitIndexes.length ? 2 : 1, id: crypto.randomUUID(), phase: "prepared", original: before, beforeHash: digest(before), afterHash: digest(after), ...(gitIndexes.length ? { gitIndexes } : {}), ...(references ? { gitReferences: references.participant } : {}) };
  let saved: string;
  try { saved = await publish(home, checkpoint, null, io); } catch (error) { references?.dispose(); throw error; }
  const bytes = new TextEncoder().encode(after);
  try {
    await options.afterBoundary?.("checkpoint-published", -1);
    await assertIndexes(original.config, gitIndexes, false, checkpoint.gitReferences);
    for (const [index, participant] of gitIndexes.entries()) await acquireNativeLock(participant.lock, lockOptions(gitIndexes, options, index));
    if (checkpoint.gitReferences) for (const [index, lock] of checkpoint.gitReferences.locks.entries()) await acquireNativeLock(lock, referenceLockOptions(gitIndexes, checkpoint.gitReferences, options, index));
    await assertIndexes(original.config, gitIndexes, true, checkpoint.gitReferences);
    await references?.guard(); await options.beforeAdmission?.();
    const indexes = new Set(gitIndexFiles(gitIndexes));
    if (transaction.deletes.some(path => indexes.has(path)) || transaction.symlinks?.some(link => indexes.has(link.path))) throw fail();
    const pinPaths = new Set(references?.participant.pins.map(pin => pin.path)); let retentionVerified = !references;
    await applyRecoverableFileTransaction({ ...transaction,
      writes: [...(references?.retentionWrites ?? []), ...transaction.writes, ...(references?.files.writes ?? [])], deletes: [...transaction.deletes, ...(references?.files.deletes ?? [])],
      finalWrites: [{ path: profilePath(home), bytes, mode: 0o600 }],
      beforeCommit: async (index, path) => {
        await assertIndexes(original.config, gitIndexes, true, checkpoint.gitReferences);
        await references?.guard(path);
        // The whole-workspace admission guard ran under every native lock,
        // before file staging. Staging now adds owned artifacts to the working
        // tree, so recapturing it here would reject our own transaction. Keep
        // the per-target source guards (also repeated at mutation) instead.
        if (!retentionVerified && !pinPaths.has(path)) { await references!.verifyRetention(); retentionVerified = true; }
        if (path === profilePath(home)) { if (await io.read(path) !== before) throw fail(); }
        else await transaction.beforeCommit?.(index, path);
      },
    }, {
      ...fileAuthority(home, original.config, roots, gitIndexes, checkpoint.gitReferences),
      beforeMutation: () => assertIndexes(original.config, gitIndexes, true, checkpoint.gitReferences),
      afterBoundary: async (phase, index) => {
        if (phase === "prepared") {
          await options.afterBoundary?.("file-plan-published", -1);
          checkpoint = { ...checkpoint, phase: "applying" };
          saved = await publish(home, checkpoint, saved, io);
          await options.afterBoundary?.("checkpoint-applying", -1);
        }
        await options.afterBoundary?.(phase, index);
      },
      beforeForget: async (result, ownership) => {
        await assertIndexes(original.config, gitIndexes, true, checkpoint.gitReferences);
        checkpoint = await decision(home, checkpoint, result, io);
        if (checkpoint.gitReferences && result.outcome === "cleanup") checkpoint = { ...checkpoint, gitReferences: retainPinOwnership(checkpoint.gitReferences, ownership) };
        saved = await publish(home, checkpoint, saved, io);
        await options.afterBoundary?.("checkpoint-settled", -1);
      },
    });
    await options.afterBoundary?.("files-finished", -1);
    await retire(home, checkpoint, saved, io, options);
  } catch (error) {
    // A normal caught rollback may already have a durable receipt. Never infer
    // completion from a missing journal once native mutation was admitted.
    if (!await exists(activePath(home))) {
      const current = await readCheckpoint(home, io);
      if (current) await retire(home, current.value, current.text, io, options);
    }
    throw error;
  } finally { bytes.fill(0); references?.dispose(); }
}

export async function recoverProfileCheckpoint(home: string, roots: Roots, io: ProfileCheckpointIO,
  options: ProfileCheckpointOptions = {}): Promise<MaterializationRecoveryResult> {
  try {
    const loaded = await readCheckpoint(home, io);
    if (!loaded) { await assertNoProfileCheckpoint(home); return { pending: false, outcome: "none", targets: 0 }; }
    let checkpoint = loaded.value, saved = loaded.text;
    const original = decodeProfile(checkpoint.original).config, gitIndexes = checkpoint.gitIndexes ?? [];
    const journalExists = await exists(activePath(home));
    await assertIndexes(original, gitIndexes, journalExists, checkpoint.gitReferences);
    if (!journalExists) {
      await canRetire(home, checkpoint, io);
      if (checkpoint.gitReferences) await retireGitPins(gitIndexes, checkpoint.gitReferences, checkpoint.settled?.outcome === "cleanup", { dryRun: true });
      const result: MaterializationRecoveryResult = { pending: true, outcome: checkpoint.settled?.outcome ?? "rollback", targets: 0 };
      if (!options.dryRun) await retire(home, checkpoint, saved, io, options);
      return result;
    }
    const configured = fileAuthority(home, original, roots, gitIndexes, checkpoint.gitReferences);
    const preview = await recoverFileTransactions({ ...configured, dryRun: true });
    if (checkpoint.phase === "settled") {
      if (checkpoint.settled!.outcome !== preview.outcome) throw fail();
      await canRetire(home, checkpoint, io);
    }
    if (options.dryRun) return preview;
    if (checkpoint.phase === "prepared") {
      checkpoint = { ...checkpoint, phase: "applying" };
      saved = await publish(home, checkpoint, saved, io);
    }
    const result = await recoverFileTransactions({ ...configured,
      beforeMutation: () => assertIndexes(original, gitIndexes, true, checkpoint.gitReferences),
      afterBoundary: options.afterBoundary,
      beforeForget: async (result, ownership) => {
        await assertIndexes(original, gitIndexes, true, checkpoint.gitReferences);
        checkpoint = await decision(home, checkpoint, result, io);
        if (checkpoint.gitReferences && result.outcome === "cleanup") checkpoint = { ...checkpoint, gitReferences: retainPinOwnership(checkpoint.gitReferences, ownership) };
        saved = await publish(home, checkpoint, saved, io);
        await options.afterBoundary?.("checkpoint-settled", -1);
      },
    });
    await options.afterBoundary?.("files-finished", -1);
    await retire(home, checkpoint, saved, io, options);
    return result;
  } catch { throw fail(); }
}

async function decision(home: string, checkpoint: Checkpoint, result: MaterializationRecoveryResult, io: ProfileCheckpointIO): Promise<Checkpoint> {
  if (result.outcome === "none") throw fail();
  const expected = result.outcome === "cleanup" ? checkpoint.afterHash : checkpoint.beforeHash;
  const current = await io.read(profilePath(home));
  if (current === null || digest(current) !== expected) throw fail();
  return { ...checkpoint, phase: "settled", settled: { outcome: result.outcome, profileHash: expected } };
}
async function canRetire(home: string, checkpoint: Checkpoint, io: ProfileCheckpointIO): Promise<void> {
  if (checkpoint.phase === "applying") throw fail();
  const expected = checkpoint.settled?.profileHash ?? checkpoint.beforeHash;
  const current = await io.read(profilePath(home));
  if (current === null || digest(current) !== expected) throw fail();
}
async function retire(home: string, checkpoint: Checkpoint, saved: string, io: ProfileCheckpointIO, options: ProfileCheckpointOptions): Promise<void> {
  if (await exists(activePath(home))) throw fail();
  await canRetire(home, checkpoint, io);
  if (await io.read(checkpointPath(home), { maximumBytes: MAX_CHECKPOINT_BYTES, private: true }) !== saved) throw fail();
  const gitIndexes = checkpoint.gitIndexes ?? [];
  await assertIndexes(decodeProfile(checkpoint.original).config, gitIndexes, false, checkpoint.gitReferences);
  if (checkpoint.gitReferences) await retireGitPins(gitIndexes, checkpoint.gitReferences, checkpoint.settled?.outcome === "cleanup", { afterRemoval: index => Promise.resolve(options.afterBoundary?.("retention-removed", index)) });
  if (checkpoint.gitReferences) for (let index = checkpoint.gitReferences.locks.length - 1; index >= 0; index--) await releaseNativeLock(checkpoint.gitReferences.locks[index], referenceLockOptions(gitIndexes, checkpoint.gitReferences, options, index));
  for (let index = gitIndexes.length - 1; index >= 0; index--) await releaseNativeLock(gitIndexes[index].lock, lockOptions(gitIndexes, options, index));
  await rm(checkpointPath(home));
  const directory = await open(home, "r"); try { await directory.sync(); } finally { await directory.close(); }
}
function lockOptions(participants: readonly GitIndexParticipant[], options: ProfileCheckpointOptions, index: number): NativeLockOptions {
  return { grants: gitIndexGrants(participants), afterBoundary: phase => options.afterBoundary?.(`native-${phase}`, index) };
}
function referenceLockOptions(indexes: readonly GitIndexParticipant[], references: GitReferenceParticipant, options: ProfileCheckpointOptions, index: number): NativeLockOptions {
  return { grants: [validateGitReferences(indexes, references).locks[index]], afterBoundary: phase => options.afterBoundary?.(`reference-${phase}`, index) };
}
async function assertIndexes(config: LocalConfig, participants: readonly GitIndexParticipant[], held: boolean, references?: GitReferenceParticipant): Promise<void> {
  await validateGitIndexes(config, participants);
  const grants = gitIndexGrants(participants);
  // Validate the complete set before replaying any file or releasing any lock.
  for (const participant of participants) {
    if (held) await assertNativeLockHeld(participant.lock, { grants });
    else await releaseNativeLock(participant.lock, { grants, dryRun: true });
  }
  if (references) {
    const grants = validateGitReferences(participants, references).locks;
    await assertNoGitGc(participants);
    for (const [index, lock] of references.locks.entries()) {
      if (held) await assertNativeLockHeld(lock, { grants: [grants[index]] });
      else await releaseNativeLock(lock, { grants: [grants[index]], dryRun: true });
    }
  }
}
function fileAuthority(home: string, config: LocalConfig, roots: Roots, participants: readonly GitIndexParticipant[], references?: GitReferenceParticipant) {
  return { directory: join(home, "materialization"), roots: roots(config), files: [profilePath(home), ...gitIndexFiles(participants), ...(references ? validateGitReferences(participants, references).files : [])], excludedRoots: gitMetadataExclusions(config, participants) };
}
async function readCheckpoint(home: string, io: ProfileCheckpointIO): Promise<{ value: Checkpoint; text: string } | null> {
  const text = await io.read(checkpointPath(home), { maximumBytes: MAX_CHECKPOINT_BYTES, private: true });
  if (text === null) return null;
  try {
    const value = schema.parse(JSON.parse(text));
    if (Buffer.byteLength(value.original) > MAX_PROFILE_BYTES || digest(value.original) !== value.beforeHash || decodeProfile(value.original).format !== 2 ||
        (value.version >= 2 ? !value.gitIndexes?.length : value.gitIndexes !== undefined) || (value.version === 3) !== Boolean(value.gitReferences) ||
        (value.phase === "settled") !== Boolean(value.settled) || (value.settled && value.settled.profileHash !== (value.settled.outcome === "cleanup" ? value.afterHash : value.beforeHash))) throw fail();
    return { value, text };
  } catch { throw fail(); }
}
async function publish(home: string, checkpoint: Checkpoint, expected: string | null, io: ProfileCheckpointIO): Promise<string> {
  const text = `${JSON.stringify(checkpoint)}\n`;
  if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES || await io.read(checkpointPath(home), { maximumBytes: MAX_CHECKPOINT_BYTES, private: true }) !== expected) throw fail();
  await io.write(checkpointPath(home), text);
  return text;
}
function invariantProfile(config: LocalConfig): string {
  return canonicalJson({ ...config, applied: {}, sessionBindings: {}, runtime: { ...config.runtime, harnesses: config.runtime?.harnesses ?? {} } });
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw fail(); }
}
