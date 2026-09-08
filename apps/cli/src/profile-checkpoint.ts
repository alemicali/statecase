import { createHash } from "node:crypto";
import { lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@statecase/protocol";
import { z } from "zod";
import type { LocalConfig } from "./config.js";
import { decodeProfile, MAX_PROFILE_BYTES, ProfileFormatError } from "./profile-format.js";
import { applyRecoverableFileTransaction, recoverFileTransactions, type MaterializationRecoveryOptions, type MaterializationRecoveryResult } from "./materialization-recovery.js";
import type { FileTransaction } from "./materialize.js";

const MAX_CHECKPOINT_BYTES = MAX_PROFILE_BYTES * 2 + 16 * 1024;
const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const schema = z.object({ version: z.literal(1), id: z.uuid(), phase: z.enum(["prepared", "applying", "settled"]),
  original: z.string().max(MAX_PROFILE_BYTES), beforeHash: hash, afterHash: hash,
  settled: z.object({ outcome: z.enum(["rollback", "cleanup"]), profileHash: hash }).strict().optional() }).strict();
type Checkpoint = z.infer<typeof schema>;
export interface ProfileCheckpointIO {
  read(path: string, options?: { maximumBytes?: number; private?: boolean }): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
}
export interface ProfileCheckpointOptions {
  dryRun?: boolean;
  afterBoundary?: (phase: Parameters<NonNullable<MaterializationRecoveryOptions["afterBoundary"]>>[0] |
    "checkpoint-published" | "file-plan-published" | "checkpoint-applying" | "checkpoint-settled" | "files-finished", index: number) => void | Promise<void>;
}
type Roots = (config: LocalConfig) => string[];
const fail = () => new ProfileFormatError("PROFILE_RECOVERY_REQUIRED");
const checkpointPath = (home: string) => join(home, "profile-materialization.json");
const activePath = (home: string) => join(home, "materialization", "active.jsonl");
const profilePath = (home: string) => join(home, "config.json");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

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
  const original = decodeProfile(before), desired = decodeProfile(after);
  if (original.format !== 2 || desired.format !== 2 || invariantProfile(original.config) !== invariantProfile(desired.config)) throw fail();
  let checkpoint: Checkpoint = { version: 1, id: crypto.randomUUID(), phase: "prepared", original: before, beforeHash: digest(before), afterHash: digest(after) };
  let saved = await publish(home, checkpoint, null, io);
  const bytes = new TextEncoder().encode(after);
  try {
    await options.afterBoundary?.("checkpoint-published", -1);
    await applyRecoverableFileTransaction({ ...transaction, finalWrites: [{ path: profilePath(home), bytes, mode: 0o600 }],
      beforeCommit: async (index, path) => {
        if (path === profilePath(home)) { if (await io.read(path) !== before) throw fail(); }
        else await transaction.beforeCommit?.(index, path);
      },
    }, {
      directory: join(home, "materialization"), roots: roots(original.config), files: [profilePath(home)],
      afterBoundary: async (phase, index) => {
        if (phase === "prepared") {
          await options.afterBoundary?.("file-plan-published", -1);
          checkpoint = { ...checkpoint, phase: "applying" };
          saved = await publish(home, checkpoint, saved, io);
          await options.afterBoundary?.("checkpoint-applying", -1);
        }
        await options.afterBoundary?.(phase, index);
      },
      beforeForget: async (result) => {
        checkpoint = await decision(home, checkpoint, result, io);
        saved = await publish(home, checkpoint, saved, io);
        await options.afterBoundary?.("checkpoint-settled", -1);
      },
    });
    await options.afterBoundary?.("files-finished", -1);
    await retire(home, checkpoint, saved, io);
  } catch (error) {
    // A normal caught rollback may already have a durable receipt. Never infer
    // completion from a missing journal once native mutation was admitted.
    if (!await exists(activePath(home))) {
      const current = await readCheckpoint(home, io);
      if (current) await retire(home, current.value, current.text, io);
    }
    throw error;
  } finally { bytes.fill(0); }
}

export async function recoverProfileCheckpoint(home: string, roots: Roots, io: ProfileCheckpointIO,
  options: ProfileCheckpointOptions = {}): Promise<MaterializationRecoveryResult> {
  try {
    const loaded = await readCheckpoint(home, io);
    if (!loaded) { await assertNoProfileCheckpoint(home); return { pending: false, outcome: "none", targets: 0 }; }
    let checkpoint = loaded.value, saved = loaded.text;
    const journalExists = await exists(activePath(home));
    if (!journalExists) {
      await canRetire(home, checkpoint, io);
      const result: MaterializationRecoveryResult = { pending: true, outcome: checkpoint.settled?.outcome ?? "rollback", targets: 0 };
      if (!options.dryRun) await retire(home, checkpoint, saved, io);
      return result;
    }
    const configured = { directory: join(home, "materialization"), roots: roots(decodeProfile(checkpoint.original).config), files: [profilePath(home)] };
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
      afterBoundary: options.afterBoundary,
      beforeForget: async (result) => {
        checkpoint = await decision(home, checkpoint, result, io);
        saved = await publish(home, checkpoint, saved, io);
        await options.afterBoundary?.("checkpoint-settled", -1);
      },
    });
    await options.afterBoundary?.("files-finished", -1);
    await retire(home, checkpoint, saved, io);
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
async function retire(home: string, checkpoint: Checkpoint, saved: string, io: ProfileCheckpointIO): Promise<void> {
  if (await exists(activePath(home))) throw fail();
  await canRetire(home, checkpoint, io);
  if (await io.read(checkpointPath(home), { maximumBytes: MAX_CHECKPOINT_BYTES, private: true }) !== saved) throw fail();
  await rm(checkpointPath(home));
  const directory = await open(home, "r"); try { await directory.sync(); } finally { await directory.close(); }
}
async function readCheckpoint(home: string, io: ProfileCheckpointIO): Promise<{ value: Checkpoint; text: string } | null> {
  const text = await io.read(checkpointPath(home), { maximumBytes: MAX_CHECKPOINT_BYTES, private: true });
  if (text === null) return null;
  try {
    const value = schema.parse(JSON.parse(text));
    if (Buffer.byteLength(value.original) > MAX_PROFILE_BYTES || digest(value.original) !== value.beforeHash || decodeProfile(value.original).format !== 2 ||
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
