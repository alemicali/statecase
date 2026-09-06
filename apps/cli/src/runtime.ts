import type { LocalConfig, LocalSecrets, ConfigStore } from "./config.js";
import { RemoteError, StatecaseClient } from "./client.js";

export class StatecaseUsageError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message);
    this.name = "StatecaseUsageError";
  }
}

export async function requireSession(store: ConfigStore, fetchImplementation: typeof fetch): Promise<{
  config: LocalConfig;
  secrets: LocalSecrets;
  client: StatecaseClient;
}> {
  const config = await store.loadConfig();
  config.mappings ??= [];
  config.workspaces ??= [];
  config.applied ??= {};
  const secrets = await store.loadSecrets();
  if (!secrets.token) throw new StatecaseUsageError("run statecase login first", 3);
  return { config, secrets, client: new StatecaseClient(config.apiUrl, secrets.token, fetchImplementation) };
}

export function selectedVault(config: LocalConfig, secrets: LocalSecrets): string {
  if (!config.selectedVaultId) throw new StatecaseUsageError("select or create a vault first", 2);
  if (!secrets.vaultKeys[config.selectedVaultId] && !secrets.scopedVaults?.[config.selectedVaultId]) {
    throw new StatecaseUsageError("selected vault key is unavailable", 2);
  }
  return config.selectedVaultId;
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof StatecaseUsageError) return error.exitCode;
  if (error instanceof RemoteError) {
    if (error.status === 401) return 3;
    if (error.status === 403 || error.status === 404) return 4;
    if (error.status === 409) return 5;
    if (error.status === 0 || error.status >= 500 || error.status === 429) return 7;
  }
  if ((error as { name?: string }).name === "SyncConflict") return 5;
  if ((error as { name?: string }).name === "SessionDependencyError") return 6;
  if ((error as { name?: string }).name === "CryptoFailure") return 6;
  return 10;
}
