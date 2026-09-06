import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type MappingKind = "drop" | "codex" | "claude";
export type MappingMode = "two-way" | "publish" | "consume" | "append";

export interface RootMapping {
  id: string;
  kind: MappingKind;
  mode: MappingMode;
  name: string;
  namespace: string;
  path: string;
}

export interface LocalConfig {
  version: 1;
  apiUrl: string;
  deviceName?: string;
  selectedVaultId?: string;
  mappings: RootMapping[];
  workspaces: Array<{ id: string; path: string; name?: string; sync?: "git" | "identity-only" }>;
  applied: Record<string, { revisionId: string; digests: Record<string, string> }>;
  runtime?: {
    shimDir?: string;
    harnesses: Partial<Record<"codex" | "claude", { realExecutable: string; shimPath?: string }>>;
  };
}

export interface LocalSecrets {
  version: 1;
  token?: string;
  vaultKeys: Record<string, string>;
}

export class ConfigStore {
  readonly home: string;

  constructor(home = process.env.STATECASE_HOME ?? join(homedir(), ".statecase")) {
    this.home = resolve(home);
  }

  async loadConfig(): Promise<LocalConfig> {
    return readJson(join(this.home, "config.json"), {
      version: 1,
      apiUrl: process.env.STATECASE_API_URL ?? "https://statecase-api-mvp.hi-0e6.workers.dev",
      mappings: [],
      workspaces: [],
      applied: {},
    });
  }

  async saveConfig(config: LocalConfig): Promise<void> {
    await atomicJson(join(this.home, "config.json"), config);
  }

  async loadSecrets(): Promise<LocalSecrets> {
    return readJson(join(this.home, "credentials.json"), { version: 1, vaultKeys: {} });
  }

  async saveSecrets(secrets: LocalSecrets): Promise<void> {
    await atomicJson(join(this.home, "credentials.json"), secrets);
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}
