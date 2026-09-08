import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ProfileLock } from "@statecase/runtime";

import { CredentialFile, type CredentialFileOptions } from "./credentials.js";
import { memoryMappings } from "./memory-bindings.js";

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

  async loadConfig(): Promise<LocalConfig> {
    const text = await readConfigText(join(this.home, "config.json"));
    const config: LocalConfig = text === null ? {
      version: 1,
      apiUrl: process.env.STATECASE_API_URL ?? "https://statecase-api.hi-0e6.workers.dev",
      mappings: [],
      workspaces: [],
      applied: {},
      sessionBindings: {},
    } : JSON.parse(text) as LocalConfig;
    this.#observed.set(config, fingerprint(text));
    return config;
  }

  async saveConfig(config: LocalConfig): Promise<void> {
    memoryMappings(config);
    let lock: ProfileLock;
    try { lock = await ProfileLock.acquire(join(this.home, "config.lock")); }
    catch { throw new ConfigStateChanged(); }
    try {
      const path = join(this.home, "config.json");
      if (fingerprint(await readConfigText(path)) !== (this.#observed.get(config) ?? null)) throw new ConfigStateChanged();
      const text = `${JSON.stringify(config, null, 2)}\n`;
      await atomicJson(path, text);
      this.#observed.set(config, fingerprint(text));
    } finally { await lock.release(); }
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
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicJson(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}
