import { execFile } from "node:child_process";
import type { BigIntStats } from "node:fs";
import { constants, lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceReferencePlan } from "@statecase/workspace";
import { z } from "zod";
import type { GitIndexParticipant } from "./git-index-participant.js";
import { nativeLockSchema, prepareNativeLock } from "./native-lock.js";
import { targetFingerprint, type FileTransaction } from "./materialize.js";
import { ProfileFormatError } from "./profile-format.js";
import type { MaterializationOwnership } from "./materialization-recovery.js";
import { assertNativeLockHeld } from "./native-lock.js";

const path = z.string().min(1).max(4096), oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u).nullable();
const branch = z.string().min(1).max(1024).refine(validBranch).nullable();
const head = z.object({ baseCommit: oid, headRef: branch }).strict().refine(value => value.baseCommit !== null || value.headRef !== null);
const referenceSchema = z.object({ root: path, indexPath: path, before: head, after: head, targetOriginalCommit: oid }).strict();
const pinSchema = z.object({ root: path, path, oid: oid.unwrap(), fingerprint: z.string().min(1).max(8192).optional() }).strict();
export const gitReferenceSchema = z.object({ version: z.literal(1), id: z.uuid(), plans: z.array(referenceSchema).min(1).max(32),
  locks: z.array(nativeLockSchema).min(1).max(256), pins: z.array(pinSchema).max(96) }).strict();
export type GitReferenceParticipant = z.infer<typeof gitReferenceSchema>;
const execute = promisify(execFile), fail = () => new ProfileFormatError("PROFILE_RECOVERY_REQUIRED");
interface Observation { path: string; bytes: Buffer | null; fingerprint: string; mode: number }

/** Files-backend participant. Operational reference writes are returned to the
 * same durable file/index/profile journal, never performed during preparation. */
export async function prepareGitReferences(indexes: readonly GitIndexParticipant[], values: readonly WorkspaceReferencePlan[]): Promise<{
  participant: GitReferenceParticipant; files: FileTransaction; retentionWrites: FileTransaction["writes"];
  guard(path?: string): Promise<void>; verifyRetention(): Promise<void>; dispose(): void;
}> {
  const observations = new Map<string, Observation>();
  try {
    const plans = z.array(referenceSchema).min(1).max(32).parse(values);
    const id = crypto.randomUUID(), authority = referenceAuthority(indexes, plans, id);
    const files: FileTransaction = { writes: [], deletes: [] }, writes: Array<{ path: string; bytes: Buffer; mode: number }> = [], deletes: string[] = [];
    const observe = async (path: string, maximum = 4096) => {
      let current = observations.get(path);
      if (!current) { current = await readNative(path, maximum); observations.set(path, current); }
      return current;
    };
    // Reject non-files backends before allocating native parents or locks.
    for (const index of indexes) {
      const result = await execute("git", ["-C", index.layout.root, "config", "--get", "extensions.refStorage"], { env: environment(), timeout: 10000, maxBuffer: 4096, encoding: "utf8" })
        .then(value => value.stdout.trim(), error => { if ((error as { code?: unknown }).code === 1) return "files"; throw fail(); });
      if (result !== "files") throw fail();
    }
    await assertNoGitGc(indexes);
    const packed = new Map<string, { observed: Observation; current: string }>();
    for (const plan of plans) {
      const index = indexes.find(index => index.layout.root === plan.root)!;
      const headPath = join(index.layout.gitDir, "HEAD"), packedPath = join(index.layout.commonDir, "packed-refs");
      const oldHead = await observe(headPath);
      if (!oldHead.bytes || parseHead(nativeText(oldHead.bytes)) !== headIdentity(plan.before)) throw fail();
      let packedState = packed.get(packedPath);
      if (!packedState) { const observed = await observe(packedPath, 32 * 1024 * 1024); packedState = { observed, current: observed.bytes ? nativeText(observed.bytes) : "" }; packed.set(packedPath, packedState); }
      const packedRefs = parsePacked(packedState.current);
      const logSetting = await execute("git", ["-C", plan.root, "config", "--get", "core.logAllRefUpdates"], { env: environment(), timeout: 10000, maxBuffer: 4096, encoding: "utf8" })
        .then(value => value.stdout.trim().toLowerCase(), error => { if ((error as { code?: unknown }).code === 1) return "true"; throw fail(); });
      // Git distinguishes a valueless key (true) from an empty string (false),
      // and accepts nonzero integers. Delegate boolean parsing to Git itself.
      const createLogs = logSetting === "always" || await execute("git", ["-C", plan.root, "config", "--bool", "--get", "core.logAllRefUpdates"], { env: environment(), timeout: 10000, maxBuffer: 4096, encoding: "utf8" })
        .then(value => { const text = value.stdout.trim(); if (text !== "true" && text !== "false") throw fail(); return text === "true"; }, error => { if ((error as { code?: unknown }).code === 1) return true; throw fail(); });
      const appendLog = async (path: string, before: string | null, after: string | null) => {
        const original = await observe(path, 32 * 1024 * 1024);
        if (!createLogs && original.bytes === null) return;
        if (original.bytes?.length && original.bytes.at(-1) !== 10) throw fail();
        const size = before?.length ?? after?.length ?? 40, zero = "0".repeat(size);
        const entry = Buffer.from(`${before ?? zero} ${after ?? zero} Statecase <statecase@localhost> ${Math.floor(Date.now() / 1000)} +0000\tstatecase: synchronize workspace\n`);
        writes.push({ path, bytes: Buffer.concat([original.bytes ?? Buffer.alloc(0), entry]), mode: original.mode }); entry.fill(0);
      };
      if (plan.before.headRef !== null) {
        const previous = await observe(join(index.layout.commonDir, "refs", "heads", plan.before.headRef));
        const effective = directRef(previous.bytes) ?? packedRefs.get(`refs/heads/${plan.before.headRef}`) ?? null;
        if (effective !== plan.before.baseCommit) throw fail();
      }
      if (plan.after.headRef !== null) {
        const ref = `refs/heads/${plan.after.headRef}`, refPath = join(index.layout.commonDir, ref), original = await observe(refPath);
        const effective = directRef(original.bytes) ?? packedRefs.get(ref) ?? null;
        if (effective !== plan.targetOriginalCommit) throw fail();
        if (plan.after.baseCommit !== effective) {
          if (plan.after.baseCommit === null) {
            if (original.bytes) deletes.push(refPath);
            if (packedRefs.has(ref)) packedState.current = removePacked(packedState.current, ref);
            const log = await observe(join(index.layout.commonDir, "logs", ref), 32 * 1024 * 1024);
            if (log.bytes) deletes.push(log.path);
          } else {
            writes.push({ path: refPath, bytes: Buffer.from(`${plan.after.baseCommit}\n`), mode: original.mode });
            await appendLog(join(index.layout.commonDir, "logs", ref), effective, plan.after.baseCommit);
          }
        }
      }
      const desired = headIdentity(plan.after);
      if (desired !== headIdentity(plan.before)) writes.push({ path: headPath, bytes: Buffer.from(`${desired}\n`), mode: oldHead.mode });
      if (desired !== headIdentity(plan.before) || plan.before.baseCommit !== plan.after.baseCommit) await appendLog(join(index.layout.gitDir, "logs", "HEAD"), plan.before.baseCommit, plan.after.baseCommit);
    }
    for (const [path, state] of packed) if (state.current !== (state.observed.bytes?.toString("utf8") ?? "")) writes.push({ path, bytes: Buffer.from(state.current), mode: state.observed.mode });
    if (new Set([...writes.map(write => write.path), ...deletes]).size !== writes.length + deletes.length) throw fail();
    const retentionWrites: Array<{ path: string; bytes: Buffer; mode: number }> = [];
    for (const pin of authority.pins) {
      if ((await observe(pin.path)).bytes !== null) throw fail();
      retentionWrites.push({ path: pin.path, bytes: Buffer.from(`${pin.oid}\n`), mode: 0o600 });
    }
    for (const grant of authority.locks) await ensureParents(grant.root, grant.path);
    const locks = [];
    for (const grant of authority.locks) locks.push(await prepareNativeLock(grant.path, { grants: [grant] }));
    const participant = gitReferenceSchema.parse({ version: 1, id, plans, locks, pins: authority.pins });
    const guard = async (path?: string) => { for (const observation of observations.values()) if ((path === undefined || path === observation.path) && await targetFingerprint(observation.path) !== observation.fingerprint) throw fail(); };
    await guard();
    files.writes = writes; files.deletes = deletes;
    return { participant, files, retentionWrites, guard, verifyRetention: async () => {
      await assertNoGitGc(indexes);
      for (const pin of authority.pins) {
        const observed = await readNative(pin.path, 256);
        try { if (observed.bytes?.toString("utf8") !== `${pin.oid}\n`) throw fail(); } finally { observed.bytes?.fill(0); }
        const repository = indexes.find(index => index.layout.commonDir === pin.root)!;
        await execute("git", ["-C", repository.layout.root, "cat-file", "-e", `${pin.oid}^{commit}`], { env: environment(), timeout: 10000, maxBuffer: 4096 });
      }
    }, dispose: () => { for (const observation of observations.values()) observation.bytes?.fill(0); for (const write of [...writes, ...retentionWrites]) write.bytes.fill(0); } };
  } catch { for (const observation of observations.values()) observation.bytes?.fill(0); throw fail(); }
}

export function validateGitReferences(indexes: readonly GitIndexParticipant[], value: GitReferenceParticipant) {
  try {
    const participant = gitReferenceSchema.parse(value), authority = referenceAuthority(indexes, participant.plans, participant.id);
    if (participant.locks.length !== authority.locks.length || participant.locks.some((lock, index) => lock.root !== authority.locks[index].root || lock.path !== authority.locks[index].path)) throw fail();
    if (participant.pins.length !== authority.pins.length || participant.pins.some((pin, index) => pin.root !== authority.pins[index].root || pin.path !== authority.pins[index].path || pin.oid !== authority.pins[index].oid)) throw fail();
    return authority;
  } catch { throw fail(); }
}

function referenceAuthority(indexes: readonly GitIndexParticipant[], plans: readonly WorkspaceReferencePlan[], id: string) {
  if (plans.length !== indexes.length || new Set(plans.map(plan => plan.root)).size !== plans.length) throw fail();
  const locks = new Map<string, { root: string; path: string }>(), files = new Set<string>();
  const pins: Array<z.infer<typeof pinSchema>> = [], pinned = new Set<string>();
  const addLock = (root: string, path: string) => { if (!locks.has(path)) locks.set(path, { root, path }); };
  for (const plan of plans) {
    const index = indexes.find(index => index.layout.root === plan.root);
    if (!index || index.layout.indexPath !== plan.indexPath) throw fail();
    const { gitDir, commonDir } = index.layout;
    files.add(join(gitDir, "HEAD")); files.add(join(commonDir, "packed-refs"));
    files.add(join(gitDir, "logs", "HEAD"));
    addLock(gitDir, join(gitDir, "HEAD.lock")); addLock(commonDir, join(commonDir, "packed-refs.lock")); addLock(commonDir, join(commonDir, "gc.pid.lock"));
    if (plan.before.headRef !== null) addLock(commonDir, `${join(commonDir, "refs", "heads", plan.before.headRef)}.lock`);
    if (plan.after.headRef !== null) { const target = join(commonDir, "refs", "heads", plan.after.headRef); files.add(target); files.add(join(commonDir, "logs", "refs", "heads", plan.after.headRef)); addLock(commonDir, `${target}.lock`); }
    for (const oid of [plan.before.baseCommit, plan.after.baseCommit, plan.targetOriginalCommit]) {
      if (oid === null || pinned.has(`${commonDir}\0${oid}`)) continue;
      pinned.add(`${commonDir}\0${oid}`);
      const path = join(commonDir, "refs", "statecase", "transactions", id, String(pins.length));
      pins.push({ root: commonDir, path, oid }); files.add(path); addLock(commonDir, `${path}.lock`);
    }
  }
  if (locks.size > 256 || files.size > 479) throw fail();
  return { locks: [...locks.values()], files: [...files], pins };
}

export async function assertNoGitGc(indexes: readonly GitIndexParticipant[]) {
  for (const root of new Set(indexes.map(index => index.layout.commonDir))) {
    try { await lstat(join(root, "gc.pid")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw fail(); }
    throw fail();
  }
}
export function retainPinOwnership(value: GitReferenceParticipant, ownership: MaterializationOwnership): GitReferenceParticipant {
  return { ...value, pins: value.pins.map(pin => {
    const fingerprint = ownership.find(entry => entry.path === pin.path)?.installedFingerprint;
    if (!fingerprint) throw fail(); return { ...pin, fingerprint };
  }) };
}
export async function retireGitPins(indexes: readonly GitIndexParticipant[], value: GitReferenceParticipant, committed: boolean,
  options: { dryRun?: boolean; afterRemoval?: (index: number) => Promise<void> } = {}) {
  const authority = validateGitReferences(indexes, value);
  const inspect = async (pin: GitReferenceParticipant["pins"][number]) => {
    const fingerprint = await targetFingerprint(pin.path, { maximumBytes: 256 });
    if (fingerprint !== "absent" && (!committed || !pin.fingerprint || fingerprint !== pin.fingerprint)) throw fail();
    if (committed && !pin.fingerprint) throw fail(); return fingerprint;
  };
  for (const pin of value.pins) await inspect(pin);
  if (options.dryRun) return;
  for (const [index, pin] of value.pins.entries()) {
    if (await inspect(pin) !== "absent") {
      const lock = value.locks.find(lock => lock.path === `${pin.path}.lock`)!;
      await assertNativeLockHeld(lock, { grants: [authority.locks.find(grant => grant.path === lock.path)!] });
      await rm(pin.path); await options.afterRemoval?.(index);
    }
    const parent = await open(dirname(pin.path), constants.O_RDONLY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
  }
}
function headIdentity(value: { headRef: string | null; baseCommit: string | null }) { return value.headRef === null ? value.baseCommit! : `ref: refs/heads/${value.headRef}`; }
function parseHead(value: string) {
  const text = value.trimEnd();
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(text)) return text;
  if (text.startsWith("ref: refs/heads/") && validBranch(text.slice(16))) return text;
  throw fail();
}
function directRef(bytes: Buffer | null) {
  if (bytes === null) return null;
  const value = bytes.toString("utf8").trimEnd(); if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) throw fail(); return value;
}
function parsePacked(text: string) {
  const refs = new Map<string, string>(); let preceding = false;
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) { preceding = false; continue; }
    if (line.startsWith("^")) { if (!preceding || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(line.slice(1))) throw fail(); preceding = false; continue; }
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/.+)$/u.exec(line);
    if (!match || !validBranch(match[2]) || refs.has(match[2])) throw fail(); refs.set(match[2], match[1]); preceding = true;
  }
  return refs;
}
function removePacked(text: string, target: string) {
  let removed = false;
  return text.split("\n").filter(line => {
    if (removed && line.startsWith("^")) { removed = false; return false; }
    removed = line.endsWith(` ${target}`); return !removed;
  }).join("\n");
}
function validBranch(value: string) {
  return value !== "@" && !value.startsWith("-") && !value.includes("..") && !value.includes("@{") && !value.endsWith(".") &&
    ![...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || "~^:?*[\\".includes(character)) &&
    value.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}
async function readNative(path: string, maximum: number): Promise<Observation> {
  const fingerprint = await targetFingerprint(path, { maximumBytes: maximum });
  if (fingerprint === "absent") return { path, bytes: null, fingerprint, mode: 0o600 };
  const stat = await lstat(path, { bigint: true }); if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(maximum)) throw fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), bytes = Buffer.alloc(Number(stat.size) + 1);
  try {
    if (stableStat(await handle.stat({ bigint: true })) !== stableStat(stat)) throw fail();
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== Number(stat.size) || stableStat(await handle.stat({ bigint: true })) !== stableStat(stat) ||
        stableStat(await lstat(path, { bigint: true })) !== stableStat(stat) || await targetFingerprint(path, { maximumBytes: maximum }) !== fingerprint) throw fail();
    return { path, bytes: Buffer.from(bytes.subarray(0, bytesRead)), fingerprint, mode: Number(stat.mode & 0o777n) };
  } finally { bytes.fill(0); await handle.close(); }
}
function nativeText(bytes: Buffer) { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
function stableStat(stat: BigIntStats) { return [stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":"); }
async function ensureParents(root: string, path: string) {
  const components = relative(root, dirname(path)).split(sep).filter(Boolean);
  if (components.length >= 64 || components.some(component => component === "..")) throw fail();
  for (let count = 0; count <= components.length; count++) {
    const directory = join(root, ...components.slice(0, count));
    try { await mkdir(directory, { mode: 0o700 }); const parent = await open(dirname(directory), constants.O_RDONLY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!(await lstat(directory)).isDirectory()) throw fail();
  }
}
function environment() { return { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", LANG: "C", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv; }
