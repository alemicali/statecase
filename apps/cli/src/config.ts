import { constants, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ProfileLock } from "@statecase/runtime";

import { CredentialFile, type CredentialFileOptions } from "./credentials.js";
import { memoryMappings } from "./memory-bindings.js";
import { decodeProfile, encodeProfile, MAX_PROFILE_BYTES, ProfileFormatError } from "./profile-format.js";
import { captureFileGuard } from "./file-guard.js";
import { HarnessActivityRegistry, type ActivityHandle } from "./activity.js";

export type MappingKind = "drop" | "codex" | "claude";
export type MappingMode = "two-way" | "publish" | "consume" | "append";

export interface MemoryIdentity {
  kind: "claude-project" | "codex-global";
  harnessNamespace: string;
  workspaceId?: string;
}
export interface MemoryBinding extends MemoryIdentity {
  id: string;
  name?: string;
  path: string;
  mode: MappingMode;
}

export interface RootMapping {
  id: string;
  kind: MappingKind;
  mode: MappingMode;
  name: string;
  namespace: string;
  path: string;
  /** Internal derived mapping only; never an implicit ordinary Drop policy. */
  memory?: MemoryIdentity;
}

export interface LocalConfig {
  version: 1;
  apiUrl: string;
  deviceId?: string;
  deviceName?: string;
  selectedVaultId?: string;
  mappings: RootMapping[];
  memories?: MemoryBinding[];
  workspaces: Array<{
    id: string;
    path: string;
    name?: string;
    sync?: "git" | "identity-only";
    gitFetch?: "ask" | "auto" | "never";
  }>;
  applied: Record<string, { revisionId: string; digests: Record<string, string>; keyEpoch?: number }>;
  sessionBindings?: Record<string, string>;
  runtime?: {
    shimDir?: string;
    harnesses: Partial<Record<"codex" | "claude", { realExecutable: string; shimPath?: string }>>;
  };
}

export interface LocalSecrets {
  version: 1;
  token?: string;
  vaultKeys: Record<string, string>;
  deviceExchange?: { publicKey: string; privateKey: string };
  vaultKeyrings?: Record<string, { currentEpoch: number; keys: Record<string, string> }>;
  scopedVaults?: Record<string, {
    vaultId: string;
    keyEpoch?: number;
    namespaces: string[];
    actions: Array<"read" | "append">;
    expiresAt: number;
    namespaceKeys: Record<string, { encryptionKey: string; dedupKey: string }>;
  }>;
}

export class ConfigStore {
  readonly home: string;
  readonly #credentials: CredentialFile;
  readonly #observed = new WeakMap<LocalConfig, string | null>();

  constructor(home = process.env.STATECASE_HOME ?? join(homedir(), ".statecase"), options: CredentialFileOptions = {}) {
    this.home = resolve(home);
    this.#credentials = new CredentialFile(this.home, options);
  }

  async loadConfig(options: { allowLegacy?: boolean } = {}): Promise<LocalConfig> {
    const text = await readConfigText(join(this.home, "config.json"));
    const decoded = text === null ? undefined : decodeProfile(text);
    if (decoded?.format === 1 && !options.allowLegacy) throw new ProfileFormatError("PROFILE_UPGRADE_REQUIRED");
    const config: LocalConfig = text === null ? {
      version: 1,
      apiUrl: process.env.STATECASE_API_URL ?? "https://statecase-api.hi-0e6.workers.dev",
      mappings: [],
      workspaces: [],
      applied: {},
      sessionBindings: {},
    } : decoded!.config;
    this.#observed.set(config, fingerprint(text));
    return config;
  }

  async saveConfig(config: LocalConfig): Promise<void> {
    memoryMappings(config);
    const text = encodeProfile(config);
    let lock: ProfileLock;
    try { lock = await ProfileLock.acquire(join(this.home, "config.lock")); }
    catch { throw new ConfigStateChanged(); }
    try {
      const path = join(this.home, "config.json");
      const current = await readConfigText(path);
      if (current !== null && decodeProfile(current).format === 1) throw new ProfileFormatError("PROFILE_UPGRADE_REQUIRED");
      if (fingerprint(current) !== (this.#observed.get(config) ?? null)) throw new ConfigStateChanged();
      await atomicJson(path, text);
      this.#observed.set(config, fingerprint(text));
    } catch (error) {
      if (error instanceof ProfileFormatError || error instanceof ConfigStateChanged) throw error;
      throw new ProfileFormatError("PROFILE_WRITE_FAILED");
    } finally { await lock.release(); }
  }

  async profileStatus(): Promise<{ exists: boolean; format: 1 | 2; migrationRequired: boolean }> {
    const text = await readConfigText(join(this.home, "config.json"));
    const format = text === null ? 2 : decodeProfile(text).format;
    return { exists: text !== null, format, migrationRequired: format === 1 };
  }

  async upgradeProfile(options: { dryRun: boolean; beforeCommit?: () => Promise<void> }): Promise<{
    fromFormat: 1 | 2; toFormat: 2; changed: boolean; dryRun: boolean; backupPath?: string;
  }> {
    const path = join(this.home, "config.json"), original = await readConfigText(path);
    const decoded = original === null ? undefined : decodeProfile(original);
    const result = { fromFormat: decoded?.format ?? 2, toFormat: 2 as const, changed: decoded?.format === 1, dryRun: options.dryRun };
    if (!decoded || decoded.format === 2) return result;
    memoryMappings(decoded.config);
    const upgraded = encodeProfile(decoded.config);
    if (options.dryRun) return result;
    const locks: Array<ProfileLock | ActivityHandle> = [], key = randomBytes(32);
    try {
      try {
        locks.push(await ProfileLock.acquire(join(this.home, "daemon.lock")));
        const activity = new HarnessActivityRegistry(join(this.home, "locks", "harnesses"));
        locks.push(await activity.beginRestore("codex")); locks.push(await activity.beginRestore("claude"));
        locks.push(await ProfileLock.acquire(join(this.home, "config.lock")));
      } catch { throw new ConfigStateChanged(); }
      const guard = await captureFileGuard(this.home, path, key, { maximumBytes: MAX_PROFILE_BYTES });
      if (await readConfigText(path) !== original) throw new ConfigStateChanged();
      const backupPath = join(this.home, `config.pre-upgrade-v1.${crypto.randomUUID()}.json`);
      await writeSynced(backupPath, original!);
      await syncDirectory(this.home);
      await options.beforeCommit?.();
      try { await guard.assertUnchanged(); } catch { throw new ConfigStateChanged(); }
      await atomicJson(path, upgraded);
      return { ...result, backupPath };
    } catch (error) {
      if (error instanceof ProfileFormatError || error instanceof ConfigStateChanged) throw error;
      throw new ProfileFormatError("PROFILE_WRITE_FAILED");
    } finally {
      key.fill(0);
      // Release every acquired barrier even if one ownership record was changed.
      await releaseProfileLocks(locks);
    }
  }

  async loadSecrets(): Promise<LocalSecrets> {
    return this.#credentials.read();
  }

  async saveSecrets(secrets: LocalSecrets): Promise<void> {
    await this.#credentials.write(secrets);
  }

  credentialStatus(): ReturnType<CredentialFile["status"]> { return this.#credentials.status(); }
  protectCredentials(options: { dryRun?: boolean } = {}): ReturnType<CredentialFile["protect"]> { return this.#credentials.protect(options); }
}

export function sessionBindingKey(namespace: string, logicalPath: string): string {
  return `${namespace}\0${logicalPath}`;
}

export function configuredSyncRoots(config: LocalConfig): string[] {
  return [...new Set([
    ...config.mappings.map((mapping) => mapping.path),
    ...memoryMappings(config).map((mapping) => mapping.path),
    ...config.workspaces.map((workspace) => workspace.path),
  ].map((path) => resolve(path)))];
}

export class ConfigStateChanged extends Error {
  readonly code = "CONFIG_STATE_CHANGED";
  constructor() { super("local configuration changed or is being updated; reload and retry"); this.name = "ConfigStateChanged"; }
}

function fingerprint(text: string | null): string | null {
  return text === null ? null : createHash("sha256").update(text).digest("hex");
}

async function readConfigText(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined, bytes: Buffer | undefined;
  try {
    const parent = await lstat(dirname(path)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw new ProfileFormatError();
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_PROFILE_BYTES || (before.mode & 0o022) !== 0 ||
      (process.getuid && before.uid !== process.getuid())) throw new ProfileFormatError();
    bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break; length += read.bytesRead;
    }
    const after = await handle.stat(), named = await lstat(path);
    const identity = (value: typeof before) => JSON.stringify([value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.mode, value.uid, value.nlink]);
    if (length !== before.size || identity(before) !== identity(after) || identity(before) !== identity(named)) throw new ConfigStateChanged();
    return new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } catch (error) {
    if (error instanceof ConfigStateChanged || error instanceof ProfileFormatError) throw error;
    throw new ProfileFormatError();
  } finally { bytes?.fill(0); await handle?.close().catch(() => { throw new ProfileFormatError(); }); }
}

async function atomicJson(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  // Do not enter cleanup unless this operation actually created the file.
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path); await syncDirectory(dirname(path));
  }
  finally { await rm(temporary, { force: true }); }
}

async function writeSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function releaseProfileLocks(locks: Array<ProfileLock | ActivityHandle>): Promise<void> {
  const released = await Promise.allSettled(locks.reverse().map((lock) => lock.release()));
  if (released.some((entry) => entry.status === "rejected")) throw new ConfigStateChanged();
}
