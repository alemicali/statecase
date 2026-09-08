import type { LocalConfig, LocalSecrets, ConfigStore } from "./config.js";
import { ConfigStateChanged } from "./config.js";
import { RemoteError, StatecaseClient } from "./client.js";
import { CredentialStorageError } from "./credentials.js";
import { NativeFileError } from "./native-file.js";
import { InstructionError } from "@statecase/adapter-common/instructions";
import { MemoryFormatError } from "@statecase/adapter-common/memory";
import { MemoryIdentityError } from "./memory-sync.js";
import { MemoryBindingError } from "./memory-bindings.js";
import { MemoryReferenceError } from "./session-memory-paths.js";

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
  if (!secrets.vaultKeys[config.selectedVaultId] && !secrets.vaultKeyrings?.[config.selectedVaultId] && !secrets.scopedVaults?.[config.selectedVaultId]) {
    throw new StatecaseUsageError("selected vault key is unavailable", 2);
  }
  return config.selectedVaultId;
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof StatecaseUsageError) return error.exitCode;
  if (error instanceof ConfigStateChanged) return 5;
  if (error instanceof NativeFileError) return error.code === "NATIVE_FILE_CHANGED" ? 5 : 6;
  if (error instanceof MemoryBindingError) return 2;
  if (error instanceof MemoryIdentityError || error instanceof MemoryFormatError || error instanceof MemoryReferenceError) return 6;
  if (error instanceof InstructionError) return error.code === "INSTRUCTION_AUTHORITY_UNVERIFIED" ? 4 : 6;
  if (error instanceof CredentialStorageError) {
    if (error.code === "CREDENTIAL_STATE_CHANGED" || error.code === "CREDENTIAL_STORE_LOCKED") return 5;
    if (error.code === "CREDENTIAL_STORE_UNAVAILABLE" || error.code === "CREDENTIAL_COMMIT_FAILED") return 7;
    if (error.code === "CREDENTIAL_BACKEND_UNSUPPORTED") return 2;
    return 6;
  }
  if (error instanceof RemoteError) {
    if (error.status === 426) return 6;
    if (error.status === 401) return 3;
    if (error.status === 403 || error.status === 404) return 4;
    if (error.status === 409) return 5;
    if (error.status === 0 || error.status >= 500 || error.status === 429) return 7;
  }
  if ((error as { name?: string }).name === "SyncConflict") return 5;
  if ((error as { name?: string }).name === "WorkspaceBaselineUnavailable") return 5;
  if ((error as { name?: string }).name === "GitLfsContentUnavailable") return 5;
  if ((error as { name?: string }).name === "SessionDependencyError") return 6;
  if ((error as { name?: string }).name === "CryptoFailure") return 6;
  return 10;
}
