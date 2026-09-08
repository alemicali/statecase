import { constants, lstat, mkdir, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ProfileLock } from "@statecase/runtime";
import { z } from "zod";
import { applyFileTransaction, cleanupTemporary, targetFingerprint, type FileTransaction, type MaterializationLifecycle, type PreparedTarget } from "./materialize.js";

const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const identitySchema = z.string().min(1).max(8192);
const artifactSchema = z.object({ path: z.string().min(1).max(4096), identity: identitySchema }).strict();
const parentSchema = z.object({ path: z.string().min(1).max(4096), identity: identitySchema.optional() }).strict();
const entrySchema = z.object({ path: z.string().min(1).max(4096), root: z.string().min(1).max(4096),
  parents: z.array(parentSchema).min(1).max(64), artifact: artifactSchema.optional(), installedFingerprint: identitySchema.optional() }).strict();
const planSchema = z.object({ kind: z.literal("plan"), version: z.literal(1), id: z.uuid(), targets: z.array(entrySchema).max(100_000) }).strict();
const intentSchema = z.object({ kind: z.literal("intent"), index: z.number().int().nonnegative(),
  originalFingerprint: identitySchema, artifact: artifactSchema.optional() }).strict();
const commitSchema = z.object({ kind: z.literal("commit") }).strict();
type Entry = z.infer<typeof entrySchema>;
type Intent = z.infer<typeof intentSchema>;
interface Journal { plan: z.infer<typeof planSchema>; intents: Intent[]; committed: boolean }
export interface MaterializationRecoveryOptions {
  /** Explicit private device-local journal directory, outside synchronized roots. */
  directory: string;
  roots: readonly string[];
  /** Exact device-local metadata grants, never an implicit parent-directory grant. */
  files?: readonly string[];
  dryRun?: boolean;
  /** An outer coordinator must durably record its decision before journal removal. */
  beforeForget?: (result: MaterializationRecoveryResult) => Promise<void>;
  /** Isolated fault-injection boundary, never exposed as a CLI flag. */
  afterBoundary?: (phase: "prepared" | "intent" | "backup" | "install" | "commit" | "rollback" | "cleanup", index: number) => void | Promise<void>;
}
export class MaterializationRecoveryError extends Error {
  constructor() { super("materialization recovery cannot proceed safely; local work and recovery files retained"); this.name = "MaterializationRecoveryError"; }
}
export interface MaterializationRecoveryResult { pending: boolean; outcome: "none" | "rollback" | "cleanup"; targets: number }

/** Internal file-transaction primitive. CLI/Git/profile coordination must opt in
 * only when their outer durable transaction is also implemented. */
export async function applyRecoverableFileTransaction(transaction: FileTransaction, options: MaterializationRecoveryOptions): Promise<void> {
  validateOptions(options);
  if (options.dryRun || transaction.lifecycle) throw new MaterializationRecoveryError();
  // Reject escaped destinations before staging creates any directories.
  for (const path of [...transaction.writes.map((write) => write.path), ...(transaction.finalWrites ?? []).map((write) => write.path), ...(transaction.symlinks ?? []).map((link) => link.path), ...transaction.deletes]) {
    await observeParents(selectedRoot(path, options), path);
  }
  const lock = await acquire(options);
  const lifecycle = new JournalLifecycle(options);
  try {
    await recoverLocked(options);
    await applyFileTransaction({ ...transaction, lifecycle });
  } finally { try { await lifecycle.close(); } finally { await lock.release(); } }
}

export async function recoverFileTransactions(options: MaterializationRecoveryOptions): Promise<MaterializationRecoveryResult> {
  validateOptions(options);
  if (options.dryRun) return recoverLocked(options);
  const lock = await acquire(options);
  try { return await recoverLocked(options); } finally { await lock.release(); }
}

class JournalLifecycle implements MaterializationLifecycle {
  #handle?: Awaited<ReturnType<typeof open>>;
  #identity?: string;
  #size = 0;
  #entries: Entry[] = [];
  #intents: Intent[] = [];
  constructor(private readonly options: MaterializationRecoveryOptions) {}

  async prepare(id: string, targets: readonly PreparedTarget[]): Promise<void> {
    this.#entries = await Promise.all(targets.map(async (target) => {
      const root = selectedRoot(target.path, this.options);
      return { path: target.path, root, parents: await observeParents(root, target.path), artifact: target.artifact,
        installedFingerprint: target.installedFingerprint };
    }));
    const plan = planSchema.parse({ kind: "plan", version: 1, id, targets: this.#entries });
    const bytes = Buffer.from(`${JSON.stringify(plan)}\n`);
    if (bytes.length > MAX_JOURNAL_BYTES) throw new MaterializationRecoveryError();
    await syncTargets(targets);
    const temporary = join(this.options.directory, `active.${id}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    let published = false;
    try {
      await handle.writeFile(bytes); await handle.sync();
      if (await optionalStat(journalPath(this.options))) throw new MaterializationRecoveryError();
      await rename(temporary, journalPath(this.options)); published = true;
      this.#handle = handle; this.#size = bytes.length; this.#identity = fileIdentity(await handle.stat());
      await syncDirectory(this.options.directory);
      await this.options.afterBoundary?.("prepared", -1);
    } finally {
      bytes.fill(0);
      if (!published) { await handle.close(); await rm(temporary, { force: true }); }
    }
  }

  async intent(index: number, target: PreparedTarget): Promise<void> {
    const originalFingerprint = await targetFingerprint(target.path);
    if (originalFingerprint === "non-file") throw new MaterializationRecoveryError();
    const intent = intentSchema.parse({ kind: "intent", index, originalFingerprint, artifact: target.artifact });
    // Any newly created deletion reservation must reach disk before its intent.
    await syncTargets([target]);
    await this.append(intent);
    this.#intents.push(intent);
    await this.options.afterBoundary?.("intent", index);
  }

  async guard(index: number, target: PreparedTarget): Promise<void> {
    await assertParents(this.#entries[index]);
    await inspectArtifact({ ...this.#entries[index], artifact: target.artifact });
    if (target.artifact && await targetFingerprint(join(target.artifact.path, "backup")) !== "absent") throw new MaterializationRecoveryError();
    if (await targetFingerprint(target.path) !== this.#intents[index].originalFingerprint) throw new MaterializationRecoveryError();
  }

  async mutation(phase: "backup" | "install", index: number, target: PreparedTarget): Promise<void> {
    await syncTargets([target]);
    await this.options.afterBoundary?.(phase, index);
  }

  async settle(outcome: "commit" | "rollback", targets: readonly PreparedTarget[]): Promise<void> {
    await syncTargets(targets);
    if (outcome === "commit") {
      await this.append({ kind: "commit" });
      await this.options.afterBoundary?.("commit", -1);
    }
  }

  async cleanup(targets: readonly PreparedTarget[]): Promise<void> {
    if (!this.#identity) { await cleanupTemporary(targets); return; }
    await this.close();
    await recoverLocked(this.options);
    this.#identity = undefined;
  }

  async close(): Promise<void> { const handle = this.#handle; this.#handle = undefined; await handle?.close(); }
  private async append(record: Intent | { kind: "commit" }): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    try {
      if (!this.#handle || this.#size + bytes.length > MAX_JOURNAL_BYTES || fileIdentity(await lstat(journalPath(this.options))) !== this.#identity) throw new MaterializationRecoveryError();
      await this.#handle.writeFile(bytes); this.#size += bytes.length; await this.#handle.sync();
    } finally { bytes.fill(0); }
  }
}

async function recoverLocked(options: MaterializationRecoveryOptions): Promise<MaterializationRecoveryResult> {
  try { return await replayJournal(options); }
  catch { throw new MaterializationRecoveryError(); }
}

async function replayJournal(options: MaterializationRecoveryOptions): Promise<MaterializationRecoveryResult> {
  const loaded = await readJournal(options);
  if (!loaded) return { pending: false, outcome: "none", targets: 0 };
  const { journal, identity } = loaded;
  const entries = journal.plan.targets.map((entry, index) => ({ ...entry, artifact: journal.intents[index]?.artifact ?? entry.artifact }));
  // Validate the entire authority/ownership set before the first recovery write.
  for (const [index, entry] of entries.entries()) {
    validateEntry(entry, journal.plan.id, options);
    await inspectEntry(entry, journal.intents[index], journal.committed);
  }
  const result: MaterializationRecoveryResult = { pending: true, outcome: journal.committed ? "cleanup" : "rollback", targets: entries.length };
  if (options.dryRun) return result;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const action = await inspectEntry(entry, journal.intents[index], journal.committed);
    if (action === "restore") await rename(join(entry.artifact!.path, "backup"), entry.path);
    if (action === "remove") await rm(entry.path);
    if (action !== "none") {
      await syncEntry(entry);
      await options.afterBoundary?.("rollback", index);
    }
    await cleanEntry(entry, journal.intents[index], journal.committed);
    await options.afterBoundary?.("cleanup", index);
  }
  await options.beforeForget?.(result);
  if (fileIdentity(await lstat(journalPath(options))) !== identity) throw new MaterializationRecoveryError();
  await rm(journalPath(options)); await syncDirectory(options.directory);
  return result;
}

async function inspectEntry(entry: Entry, intent: Intent | undefined, committed: boolean): Promise<"none" | "restore" | "remove"> {
  await assertParents(entry);
  const artifactExists = await inspectArtifact(entry);
  const backup = artifactExists ? await targetFingerprint(join(entry.artifact!.path, "backup")) : "absent";
  if (backup !== "absent" && (!intent || backup !== intent.originalFingerprint)) throw new MaterializationRecoveryError();
  if (committed || !intent) return "none";
  const current = await targetFingerprint(entry.path), original = intent.originalFingerprint, installed = entry.installedFingerprint ?? "absent";
  if (original === "absent" && installed === "absent") return "none";
  if (current === original && backup === "absent") return "none";
  if (!artifactExists) throw new MaterializationRecoveryError();
  if (original !== "absent" && backup === original && (current === installed || current === "absent")) return "restore";
  if (original === "absent" && backup === "absent" && current === installed) return "remove";
  throw new MaterializationRecoveryError();
}

async function inspectArtifact(entry: Entry): Promise<boolean> {
  if (!entry.artifact) return false;
  const info = await optionalStat(entry.artifact.path);
  if (!info) return false;
  if (!info.isDirectory() || directoryIdentity(info) !== entry.artifact.identity) throw new MaterializationRecoveryError();
  if ((await readdir(entry.artifact.path)).some((name) => name !== "prepared" && name !== "backup")) throw new MaterializationRecoveryError();
  const prepared = await targetFingerprint(join(entry.artifact.path, "prepared"));
  if (prepared !== "absent" && prepared !== entry.installedFingerprint) throw new MaterializationRecoveryError();
  return true;
}

async function cleanEntry(entry: Entry, intent: Intent | undefined, committed: boolean): Promise<void> {
  await assertParents(entry);
  if (!await inspectArtifact(entry)) return;
  const backup = await targetFingerprint(join(entry.artifact!.path, "backup"));
  if (backup !== "absent" && (!committed || backup !== intent?.originalFingerprint)) throw new MaterializationRecoveryError();
  await rm(join(entry.artifact!.path, "prepared"), { force: true });
  if (backup !== "absent") await rm(join(entry.artifact!.path, "backup"));
  await rmdir(entry.artifact!.path); await syncDirectory(dirname(entry.path));
}

async function readJournal(options: MaterializationRecoveryOptions): Promise<{ journal: Journal; identity: string } | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined, bytes: Buffer | undefined;
  try {
    await assertPrivateDirectory(options.directory, true);
    try { handle = await open(journalPath(options), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid()) || before.size > MAX_JOURNAL_BYTES) throw new MaterializationRecoveryError();
    bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) { const part = await handle.read(bytes, size, bytes.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
    const after = await handle.stat(), named = await lstat(journalPath(options));
    if (size !== before.size || stableIdentity(before) !== stableIdentity(after) || stableIdentity(before) !== stableIdentity(named)) throw new MaterializationRecoveryError();
    const text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
    const lines = text.split("\n"); lines.pop(); // A partial final append cannot authorize a following mutation.
    const plan = planSchema.parse(JSON.parse(lines[0] ?? ""));
    const intents: Intent[] = []; let committed = false;
    for (const line of lines.slice(1)) {
      if (committed) throw new MaterializationRecoveryError();
      const record: unknown = JSON.parse(line);
      if (commitSchema.safeParse(record).success) {
        if (intents.length !== plan.targets.length) throw new MaterializationRecoveryError();
        committed = true;
      } else {
        const intent = intentSchema.parse(record);
        if (intent.index !== intents.length || intent.index >= plan.targets.length) throw new MaterializationRecoveryError();
        intents.push(intent);
      }
    }
    if (new Set(plan.targets.map((entry) => entry.path)).size !== plan.targets.length) throw new MaterializationRecoveryError();
    return { journal: { plan, intents, committed }, identity: fileIdentity(before) };
  } catch { throw new MaterializationRecoveryError(); }
  finally { bytes?.fill(0); await handle?.close(); }
}

function validateOptions(options: MaterializationRecoveryOptions): void {
  if (!canonicalPath(options.directory) || (options.roots.length === 0 && !options.files?.length) ||
      (options.files?.length ?? 0) > 128 || options.files?.some((path) => !canonicalPath(path) || contains(path, options.directory) || contains(options.directory, path)) ||
      options.roots.some((root) => !canonicalPath(root) || contains(root, options.directory) || contains(options.directory, root))) throw new MaterializationRecoveryError();
}
function selectedRoot(path: string, options: MaterializationRecoveryOptions): string {
  if (!canonicalPath(path)) throw new MaterializationRecoveryError();
  if (options.files?.includes(path)) return dirname(path);
  const root = [...options.roots].sort((a, b) => b.length - a.length).find((root) => root !== path && contains(root, path));
  if (!root) throw new MaterializationRecoveryError();
  return root;
}
function validateEntry(entry: Entry, id: string, options: MaterializationRecoveryOptions): void {
  if (selectedRoot(entry.path, options) !== entry.root || (entry.artifact && entry.artifact.path !== `${entry.path}.statecase-transaction-${id}.staged`)) throw new MaterializationRecoveryError();
  const paths = parentPaths(entry.root, entry.path);
  if (paths.length !== entry.parents.length || paths.some((path, index) => path !== entry.parents[index].path)) throw new MaterializationRecoveryError();
}
function canonicalPath(path: string): boolean { return isAbsolute(path) && resolve(path) === path && path.length <= 4096 && ![...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }
function contains(root: string, path: string): boolean { const child = relative(root, path); return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`); }
function parentPaths(root: string, path: string): string[] {
  const parts = relative(root, path).split(sep).slice(0, -1);
  return [root, ...parts.map((_part, index) => join(root, ...parts.slice(0, index + 1)))];
}
async function observeParents(root: string, path: string): Promise<Entry["parents"]> {
  return Promise.all(parentPaths(root, path).map(async (path) => {
    const info = await optionalStat(path);
    if (info && !info.isDirectory()) throw new MaterializationRecoveryError();
    return { path, identity: info ? directoryIdentity(info) : undefined };
  }));
}
async function assertParents(entry: Entry): Promise<void> {
  const current = await observeParents(entry.root, entry.path);
  if (entry.parents.some((parent, index) => parent.identity !== current[index].identity)) throw new MaterializationRecoveryError();
}
async function acquire(options: MaterializationRecoveryOptions): Promise<ProfileLock> {
  try {
    await assertPrivateDirectory(options.directory, true);
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(options.directory, false);
    return await ProfileLock.acquire(join(options.directory, "recovery.lock"));
  } catch { throw new MaterializationRecoveryError(); }
}
async function assertPrivateDirectory(path: string, allowMissing: boolean): Promise<void> {
  const info = await optionalStat(path);
  if (!info && allowMissing) return;
  if (!info?.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new MaterializationRecoveryError();
}
function journalPath(options: MaterializationRecoveryOptions): string { return join(options.directory, "active.jsonl"); }
function directoryIdentity(info: Awaited<ReturnType<typeof lstat>>): string { return JSON.stringify([info.dev, info.ino, info.mode, info.uid]); }
function fileIdentity(info: Awaited<ReturnType<typeof lstat>>): string { return JSON.stringify([info.dev, info.ino, info.mode, info.uid, info.nlink]); }
function stableIdentity(info: Awaited<ReturnType<typeof lstat>>): string { return JSON.stringify([fileIdentity(info), info.size, info.mtimeMs, info.ctimeMs]); }
async function optionalStat(path: string) { try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
async function syncEntry(entry: Entry): Promise<void> { await syncDirectory(dirname(entry.path)); if (entry.artifact && await optionalStat(entry.artifact.path)) await syncDirectory(entry.artifact.path); }
async function syncTargets(targets: readonly PreparedTarget[]): Promise<void> {
  for (const target of targets) {
    if (await optionalStat(dirname(target.path))) await syncDirectory(dirname(target.path));
    if (target.artifact) await syncDirectory(target.artifact.path);
  }
}
