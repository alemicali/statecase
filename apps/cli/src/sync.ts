import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { classifyClaudePath, claudeProjectDirectory } from "@statecase/adapter-claude";
import { classifyCodexPath } from "@statecase/adapter-codex";
import { extractActivityReferences, scanCompleteJsonl, sessionWorkingDirectory, type ActivityReference } from "@statecase/adapter-common";
import { MAX_SETTING_BYTES } from "@statecase/adapter-common/settings-transport";
import { chunkBytes, chunkJsonlStream, concatChunks } from "@statecase/chunking";
import { computeObjectId, computeObjectIdStream, decryptEnvelope, deriveScopeKey, encryptEnvelope } from "@statecase/crypto";
import {
  canonicalJson,
  manifestSchema,
  namespaceManifestSchema,
  type DependencyReference,
  type NamespaceManifestV1,
  type SessionCapsuleV1,
  type VaultManifestV1,
} from "@statecase/protocol";
import { appendOnlyViolations, mergeNamespace, namespaceStateEquals, type NamespaceState } from "@statecase/sync-core";
import {
  applyWorkspaceTransaction,
  assertWorkspaceReplacement,
  assertWorkspaceAdvance,
  captureWorkspace,
  GitLfsContentUnavailable,
  inspectWorkspaceDestination,
  replaceWorkspaceCapsule,
  type CapturedWorkspace,
  type GitFetchPolicy,
  type WorkspaceBlob,
  type WorkspaceMaterializedWrite,
  type WorkspaceApplication,
  type WorkspaceFileTransaction,
  WorkspaceBaselineUnavailable,
  workspaceMatchesCapsule,
} from "@statecase/workspace";

import { sessionBindingKey, type LocalConfig, type RootMapping } from "./config.js";
import type { ScopedVaultKeys } from "./capability.js";
import type { StatecaseClient, RemoteNamespaceHead, RemoteNamespaceRevision } from "./client.js";
import { isCompleteJsonlRecordSupersequence } from "./append-merge.js";
import { isCompleteJsonlFileRecordSupersequence, mergeJsonlAppendFiles } from "./append-merge-file.js";
import { applyFileTransaction, type FileTransaction } from "./materialize.js";
import { captureFileGuard, type FileGuard } from "./file-guard.js";
import { readSettingsSnapshot } from "./settings-file.js";
import { prepareSettingsPlan, settingsDocuments, settingsField, type IncomingSetting, type SettingsPlan } from "./settings-sync.js";
import { instructionPath, scanInstructions, prepareInstructionPlan, type IncomingInstruction, type InstructionPlan } from "./instructions-sync.js";
import { InstructionError, MAX_INSTRUCTION_BYTES, MAX_INSTRUCTION_FILES, MAX_INSTRUCTION_SET_BYTES } from "@statecase/adapter-common/instructions";
import { MemoryFormatError, memoryNativePath, MAX_MEMORY_FILES, MAX_MEMORY_FILE_BYTES, MAX_MEMORY_SET_BYTES } from "@statecase/adapter-common/memory";
import { memoryMappings } from "./memory-bindings.js";
import { createMemoryReferenceRewriter, type SessionMemoryRoot } from "./session-memory-paths.js";
import { scanMemory, prepareMemoryPlan, memoryDescriptor, MEMORY_DESCRIPTOR_PATH, MemoryIdentityError } from "./memory-sync.js";
import type { IncomingNativeText, NativeTextPlan } from "./native-text-plan.js";
import {
  inspectPortableSessionActivity,
  localizePortableSession,
  localizeWorkspaceUri,
  stagePortableSession,
} from "./session-stream.js";
import { describeStagedJsonl, downloadVerifiedEntry, uploadStagedJsonl } from "./stream-transfer.js";

const encoder = new TextEncoder();
const runFile = promisify(execFile);
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_STREAMED_SESSION_BYTES = 20 * 1024 * 1024 * 1024;
const CHUNK_POLICY = { strategy: "fastcdc" as const, minSize: 256 * 1024, targetSize: 1024 * 1024, maxSize: 4 * 1024 * 1024 };
const JSONL_CHUNK_POLICY = { targetSize: 4 * 1024 * 1024, maxSize: 4 * 1024 * 1024 };

interface ScannedEntry {
  namespace: string;
  logicalPath: string;
  bytes?: Uint8Array;
  stagedPath?: string;
  nativeStagedPath?: string;
  nativeBytes?: Uint8Array;
  stagedSize?: number;
  dispose?: () => Promise<void>;
  entryType?: "file" | "workspace-capsule" | "workspace-blob";
  workspacePath?: string;
  workspaceLayer?: "index" | "worktree";
  fileMode?: number;
  nativeRelativePath?: string;
  session?: {
    nativeSessionId: string;
    workspaceId?: string;
    activity: ActivityReference[];
  };
}

type MaterializedEntry = {
  mapping: RootMapping;
  logicalPath: string;
  path: string;
  digest: string;
} & ({ bytes: Uint8Array; sourcePath?: never } | { bytes?: never; sourcePath: string });

export interface DependencyReport extends SessionCapsuleV1 {
  dependencies: Array<DependencyReference & { status: "resolved" | "unresolved"; reason?: string }>;
}

export interface SyncResult {
  outcome: "pushed" | "pulled" | "unchanged";
  revisionId: string | null;
  files: number;
  objects: number;
  bytes: number;
}

export interface InPlaceRestoreResult extends SyncResult {
  dryRun: boolean;
  historicalRevisionId: string;
  namespace: string;
  namespaceRevisionId: string;
}

export interface InPlaceRestoreOptions {
  dryRun?: boolean;
  prepareRecovery?: (
    paths: readonly string[],
    context?: { kind: "workspace"; targetHeadRef: string | null },
  ) => Promise<{ rollback(): Promise<void> }>;
}

interface MaterializationOptions {
  allowLocalOverwrite?: boolean;
  materialize?: (transaction: FileTransaction) => Promise<void>;
  replaceWorkspaces?: boolean;
  prepareWorkspaceRecovery?: (plan: { paths: string[]; targetHeadRef: string | null }) => Promise<void>;
}

export class SyncConflict extends Error {
  constructor(readonly paths: string[]) {
    super(`local changes conflict with remote state (${paths.length} path${paths.length === 1 ? "" : "s"})`);
    this.name = "SyncConflict";
  }
}

export class SessionDependencyError extends Error {
  constructor(readonly unresolved: string[]) {
    super(`session dependency closure is incomplete (${unresolved.length} unresolved)`);
    this.name = "SessionDependencyError";
  }
}

export interface VaultKeyring {
  currentEpoch: number;
  keys: Record<number, Uint8Array>;
}

export interface SyncEngineOptions {
  /** Internal durable composition boundary. The proposal keeps the original
   * ConfigStore observation identity; it contains only applied/binding changes. */
  commitMaterialization?: (proposal: LocalConfig, workspaces: readonly WorkspaceApplication[], files: WorkspaceFileTransaction) => Promise<void>;
}

export class SyncEngine {
  readonly vaultKey?: Uint8Array;
  readonly vaultKeyring?: VaultKeyring;
  readonly keyEpoch: number;
  readonly scopedAccess?: ScopedVaultKeys;
  /** A narrowed hydration view selects content, never replacement profile
   * authority. Weak identity binding also keeps concurrent views independent. */
  readonly #materializationOwners = new WeakMap<LocalConfig, LocalConfig>();

  constructor(
    readonly client: StatecaseClient,
    readonly vaultId: string,
    access: Uint8Array | VaultKeyring | ScopedVaultKeys,
    private readonly options: SyncEngineOptions = {},
  ) {
    if (access instanceof Uint8Array) {
      if (access.byteLength !== 32) throw new TypeError("invalid vault key");
      this.vaultKey = access;
      this.vaultKeyring = { currentEpoch: 1, keys: { 1: access } };
      this.keyEpoch = 1;
    } else if ("currentEpoch" in access) {
      if (!Number.isSafeInteger(access.currentEpoch) || access.currentEpoch < 1 || access.keys[access.currentEpoch]?.byteLength !== 32) {
        throw new TypeError("invalid vault keyring");
      }
      for (const [epoch, key] of Object.entries(access.keys)) {
        if (!/^\d+$/u.test(epoch) || Number(epoch) < 1 || key.byteLength !== 32) throw new TypeError("invalid vault keyring");
      }
      this.vaultKeyring = access;
      this.vaultKey = access.keys[access.currentEpoch];
      this.keyEpoch = access.currentEpoch;
    } else {
      if (access.vaultId !== vaultId) throw new TypeError("scoped access belongs to another vault");
      this.scopedAccess = access;
      this.keyEpoch = access.keyEpoch ?? 1;
    }
  }

  async push(
    config: LocalConfig,
    dryRun = false,
    options: { resolveLocalNamespaces?: ReadonlySet<string>; expectedHeadRevisionId?: string } = {},
  ): Promise<SyncResult> {
    if (this.scopedAccess) return this.#pushScoped(config, dryRun, options);
    const scopedRemote = await this.client.namespaceHeads(this.vaultId);
    if (scopedRemote.namespaces.length > 0) return this.#pushScoped(config, dryRun, options);
    const legacyRemote = await this.client.head(this.vaultId);
    if (!legacyRemote.revisionId) return this.#pushScoped(config, dryRun, options);
    const operationId = randomId("op");
    const revisionId = randomId("rev");
    const createdAt = new Date().toISOString();
    const createdByDeviceId = config.deviceId ?? (config.deviceName ? safeIdentifier(config.deviceName, "device") : "device_unknown");
    const writable = [
      ...syncRootMappings(config).filter((mapping) => mapping.mode !== "consume"),
      ...workspaceMappings(config),
    ];
    const scanned = await scanWritableMappings(writable, config.workspaces, false, memoryMappings(config));
    try {
    if (scopedRemote.commitProvenance !== 1 && scanned.some((entry) => isInstructionAuthorityPath(entry.namespace, entry.logicalPath))) {
      throw new InstructionError("INSTRUCTION_AUTHORITY_UNVERIFIED");
    }
    const head = await this.client.head(this.vaultId);
    if (options.expectedHeadRevisionId !== undefined && head.revisionId !== options.expectedHeadRevisionId) {
      throw new SyncConflict([`${this.vaultId}:head-advanced-before-resolution`]);
    }
    if (!head.revisionId || !head.manifestObjectId) throw new Error("legacy head changed while preparing synchronization");
    const previous = await this.#downloadManifest(head.manifestObjectId);
    const writableNamespaces = new Set(writable.map((mapping) => mapping.namespace));
    if (writableNamespaces.size !== writable.length) throw new Error("duplicate writable namespace mapping");
    const plaintextChunks = new Map<string, { bytes: Uint8Array; namespace: string }>();
    const localEntries: VaultManifestV1["entries"] = [];
    for (const file of scanned) {
      const keys = await this.#scopeKeys(file.namespace);
      const objectIds: string[] = [];
      const fileBytes = requiredMemoryBytes(file);
      for (const chunk of chunkBytes(fileBytes, CHUNK_POLICY)) {
        const objectId = await computeObjectId(keys.dedupKey, chunk);
        objectIds.push(objectId);
        if (!plaintextChunks.has(objectId)) plaintextChunks.set(objectId, { bytes: chunk, namespace: file.namespace });
      }
      localEntries.push({
        namespace: file.namespace,
        logicalPath: file.logicalPath,
        entryType: file.entryType ?? "file",
        ...(file.workspacePath ? { workspacePath: file.workspacePath } : {}),
        ...(file.workspaceLayer ? { workspaceLayer: file.workspaceLayer } : {}),
        ...(file.fileMode !== undefined ? { fileMode: file.fileMode } : {}),
        objectIds,
        totalSize: fileBytes.byteLength,
        contentDigest: await computeObjectId(keys.dedupKey, fileBytes),
      });
    }
    const entries = previous.entries.filter((entry) => !writableNamespaces.has(entry.namespace));
    const tombstones = previous.tombstones.filter((item) => !writableNamespaces.has(item.namespace));
    const completelyLocalNamespaces = new Set<string>();
    const manifests = new Map<string, VaultManifestV1>();
    manifests.set(head.revisionId, previous);
    const deletedAt = new Date().toISOString();
    const mergeConflicts: string[] = [];
    for (const mapping of writable) {
      const namespace = mapping.namespace;
      const remoteState = manifestNamespaceState(previous, namespace);
      const appliedRevisionId = config.applied[namespace]?.revisionId;
      let baseState: NamespaceState;
      if (options.resolveLocalNamespaces?.has(namespace)) {
        if (!appliedRevisionId) {
          mergeConflicts.push(`${namespace}:remote-head-not-applied`);
          continue;
        }
        baseState = remoteState;
      } else if (!appliedRevisionId) {
        if (remoteState.entries.length > 0 || remoteState.tombstones.length > 0) {
          mergeConflicts.push(`${namespace}:remote-head-not-applied`);
          continue;
        }
        baseState = { entries: [], tombstones: [] };
      } else {
        let baseManifest = manifests.get(appliedRevisionId);
        if (!baseManifest) {
          try {
            const pointer = await this.client.revision(this.vaultId, appliedRevisionId);
            baseManifest = await this.#downloadManifest(pointer.manifestObjectId);
            if (baseManifest.revisionId !== appliedRevisionId) throw new Error("base revision manifest does not match its pointer");
            manifests.set(appliedRevisionId, baseManifest);
          } catch {
            mergeConflicts.push(`${namespace}:base-revision-unavailable`);
            continue;
          }
        }
        baseState = manifestNamespaceState(baseManifest, namespace);
      }
      const namespaceEntries = localEntries.filter((entry) => entry.namespace === namespace);
      const scannedPaths = new Set(namespaceEntries.map((entry) => entry.logicalPath));
      const localTombstones = baseState.tombstones.filter((item) => !scannedPaths.has(item.logicalPath));
      if (!namespace.startsWith("workspace:")) {
        for (const entry of baseState.entries) {
          if (scannedPaths.has(entry.logicalPath)) continue;
          localTombstones.push({ namespace, logicalPath: entry.logicalPath, deletedAt });
        }
      }
      const localState = { entries: namespaceEntries, tombstones: localTombstones };
      if (mapping.mode === "append") {
        const violations = appendOnlyViolations(baseState, localState);
        if (violations.length > 0) {
          mergeConflicts.push(...violations.map((path) => `${namespace}:${path}:append-only`));
          continue;
        }
      }
      const merged = mergeNamespace(baseState, remoteState, localState, { atomic: namespace.startsWith("workspace:") });
      if (merged.outcome === "conflict") {
        mergeConflicts.push(...merged.paths.map((path) => `${namespace}:${path}`));
        continue;
      }
      entries.push(...merged.state.entries);
      tombstones.push(...merged.state.tombstones);
      if (namespaceStateEquals(merged.state, localState)) completelyLocalNamespaces.add(namespace);
    }
    if (mergeConflicts.length > 0) throw new SyncConflict(mergeConflicts.sort((left, right) => left.localeCompare(right, "en")));
    entries.sort(compareEntries);
    tombstones.sort((left, right) => left.namespace.localeCompare(right.namespace, "en") || left.logicalPath.localeCompare(right.logicalPath, "en"));
    const conflicts = previous.conflicts;
    const sessionCapsules = await buildSessionCapsules({
      vaultId: this.vaultId,
      revisionId,
      createdAt,
      createdByDeviceId,
      config,
      scanned,
      entries,
      previous,
    });
    if (canonicalJson({ entries, tombstones, conflicts, sessionCapsules }) === canonicalJson({
      entries: previous.entries,
      tombstones: previous.tombstones,
      conflicts: previous.conflicts,
      sessionCapsules: previous.sessionCapsules ?? [],
    })) {
      if (!dryRun) await this.#publishNamespaceMirrors(previous, writableNamespaces);
      const appliedMappings = writable.filter((mapping) => completelyLocalNamespaces.has(mapping.namespace));
      if (!dryRun) {
        await this.#markApplied(config, appliedMappings, scanned, head.revisionId);
        await this.#markNamespaceRevisions(config, appliedMappings);
        recordSessionBindings(config, writable, scanned);
      }
      return { outcome: "unchanged", revisionId: head.revisionId, files: 0, objects: 0, bytes: 0 };
    }
    const envelopes = new Map<string, Uint8Array>();
    let transferredBytes = 0;
    for (const [objectId, chunk] of plaintextChunks) {
      const keys = await this.#scopeKeys(chunk.namespace);
      const envelope = await encryptEnvelope({
        plaintext: chunk.bytes,
        key: keys.encryptionKey,
        dedupKey: keys.dedupKey,
        context: { vaultId: this.vaultId, scopeId: chunk.namespace, compression: "none" },
      });
      envelopes.set(objectId, envelope);
      transferredBytes += envelope.byteLength;
    }
    const manifest: VaultManifestV1 = {
      schemaVersion: 1,
      vaultId: this.vaultId,
      revisionId,
      parentRevisionIds: [head.revisionId],
      createdAt,
      createdByDeviceId,
      operationId,
      entries,
      tombstones,
      conflicts,
      sessionCapsules,
    };
    const manifestBytes = encoder.encode(canonicalJson(manifest));
    const manifestKeys = await this.#scopeKeys("manifest");
    const manifestObjectId = await computeObjectId(manifestKeys.dedupKey, manifestBytes);
    const manifestEnvelope = await encryptEnvelope({
      plaintext: manifestBytes,
      key: manifestKeys.encryptionKey,
      dedupKey: manifestKeys.dedupKey,
      context: { vaultId: this.vaultId, scopeId: "manifest", compression: "none" },
    });
    if (dryRun) return { outcome: "pushed", revisionId, files: scanned.length, objects: envelopes.size + 1, bytes: transferredBytes + manifestEnvelope.byteLength };

    for (const [objectId, envelope] of envelopes) await this.client.putObject(this.vaultId, objectId, envelope);
    await this.client.putObject(this.vaultId, manifestObjectId, manifestEnvelope);
    await this.client.commit(this.vaultId, {
      protocolVersion: "1.0",
      operationId,
      baseRevisionId: head.revisionId,
      revisionId,
      manifestObjectId,
      requiredObjectIds: [...envelopes.keys()],
    });
    await this.#publishNamespaceMirrors(manifest, writableNamespaces, envelopes);
    const appliedMappings = writable.filter((mapping) => completelyLocalNamespaces.has(mapping.namespace));
    await this.#markApplied(config, appliedMappings, scanned, revisionId);
    await this.#markNamespaceRevisions(config, appliedMappings);
    recordSessionBindings(config, writable, scanned);
    return { outcome: "pushed", revisionId, files: scanned.length, objects: envelopes.size + 1, bytes: transferredBytes + manifestEnvelope.byteLength };
    } finally { for (const file of scanned) await file.dispose?.(); }
  }

  async dependencies(historicalRevisionId?: string): Promise<DependencyReport[]> {
    const manifests = new Map<string, VaultManifestV1>();
    let manifest: VaultManifestV1 | undefined;
    let scoped = Boolean(this.scopedAccess);
    if (historicalRevisionId) {
      try {
        manifest = await this.#downloadScopedVaultManifest(historicalRevisionId);
        scoped = true;
      } catch (error) {
        if (this.scopedAccess || (error as { status?: number }).status !== 404) throw error;
      }
    } else {
      const heads = await this.client.namespaceHeads(this.vaultId);
      if (heads.namespaces.length > 0) {
        manifest = await this.#downloadScopedVaultManifest(undefined, heads);
        scoped = true;
      }
    }
    if (!manifest) {
      const pointer = historicalRevisionId
        ? await this.client.revision(this.vaultId, historicalRevisionId)
        : await this.client.head(this.vaultId);
      if (!pointer.revisionId || !pointer.manifestObjectId) return [];
      manifest = await this.#downloadManifest(pointer.manifestObjectId);
    }
    manifests.set(manifest.revisionId, manifest);
    const loadRevision = async (revisionId: string): Promise<VaultManifestV1 | undefined> => {
      const cached = manifests.get(revisionId);
      if (cached) return cached;
      try {
        let loaded: VaultManifestV1 | undefined;
        if (scoped) {
          try {
            loaded = await this.#downloadScopedVaultManifest(revisionId);
          } catch (error) {
            if (this.scopedAccess || (error as { status?: number }).status !== 404) throw error;
            const revision = await this.client.revision(this.vaultId, revisionId);
            loaded = await this.#downloadManifest(revision.manifestObjectId);
          }
        } else {
          const revision = await this.client.revision(this.vaultId, revisionId);
          loaded = await this.#downloadManifest(revision.manifestObjectId);
        }
        if (!loaded || loaded.revisionId !== revisionId) return undefined;
        manifests.set(revisionId, loaded);
        return loaded;
      } catch {
        return undefined;
      }
    };
    const reports: DependencyReport[] = [];
    for (const capsule of manifest.sessionCapsules ?? []) {
      const harnessManifest = await loadRevision(capsule.harnessRevisionId);
      const workspaceManifest = await loadRevision(capsule.workspace.capsuleRevisionId);
      const dropManifests = new Map<string, VaultManifestV1 | undefined>();
      for (const drop of capsule.drops) dropManifests.set(drop.dropId, await loadRevision(drop.revisionId));
      const memoryManifests = new Map<string, VaultManifestV1 | undefined>();
      const memoryDependencies: DependencyReference[] = [];
      for (const memory of capsule.memories ?? []) {
        const pinned = await loadRevision(memory.revisionId);
        memoryManifests.set(memory.memoryId, pinned);
        const descriptor = pinned?.entries.find((entry) => entry.namespace === `memory:${memory.memoryId}` && entry.logicalPath === MEMORY_DESCRIPTOR_PATH);
        memoryDependencies.push({ logicalPath: `${memory.memoryId}/collection.json`, source: "memory", required: true,
          ...(descriptor ? { contentDigest: descriptor.contentDigest } : {}) });
      }
      const dependencies = [...capsule.dependencies, ...memoryDependencies].map((dependency) => {
        const unresolved = dependencyResolutionFailure(dependency, capsule, harnessManifest, workspaceManifest, dropManifests, memoryManifests);
        return { ...dependency, status: unresolved ? "unresolved" as const : "resolved" as const, ...(unresolved ? { reason: unresolved } : {}) };
      });
      reports.push({ ...capsule, dependencies });
    }
    return reports.sort((left, right) => left.sessionKey.localeCompare(right.sessionKey, "en"));
  }

  async #pushScoped(
    config: LocalConfig,
    dryRun: boolean,
    options: { resolveLocalNamespaces?: ReadonlySet<string>; expectedHeadRevisionId?: string } = {},
  ): Promise<SyncResult> {
    const appendOnly = Boolean(this.scopedAccess);
    if (this.scopedAccess && this.scopedAccess.expiresAt <= Date.now()) throw new Error("scoped capability has expired");
    if (this.scopedAccess && !this.scopedAccess.actions.includes("append")) throw new Error("scoped capability is read-only");
    const allowed = this.scopedAccess ? new Set(Object.keys(this.scopedAccess.namespaceKeys)) : undefined;
    const writable = [...syncRootMappings(config).filter((mapping) => mapping.mode !== "consume"), ...workspaceMappings(config)];
    const unauthorized = allowed ? writable.filter((mapping) => !allowed.has(mapping.namespace)) : [];
    if (unauthorized.length > 0) {
      throw new Error(`capability does not authorize configured namespaces: ${unauthorized.map((mapping) => mapping.namespace).sort().join(", ")}`);
    }
    if (new Set(writable.map((mapping) => mapping.namespace)).size !== writable.length) throw new Error("duplicate writable namespace mapping");
    const scanned = await scanWritableMappings(writable, config.workspaces, true, memoryMappings(config));
    try {
    const remote = await this.client.namespaceHeads(this.vaultId);
    if (remote.commitProvenance !== 1 && scanned.some((entry) => isInstructionAuthorityPath(entry.namespace, entry.logicalPath))) {
      throw new InstructionError("INSTRUCTION_AUTHORITY_UNVERIFIED");
    }
    if (options.expectedHeadRevisionId !== undefined && remote.revisionId !== options.expectedHeadRevisionId) {
      throw new SyncConflict([`${this.vaultId}:head-advanced-before-resolution`]);
    }
    const heads = new Map(remote.namespaces.map((head) => [head.namespace, head]));
    const operationId = randomId("op");
    const vaultRevisionId = randomId("srev");
    const createdAt = new Date().toISOString();
    const createdByDeviceId = config.deviceId ?? "capability_sandbox";
    const updates = [];
    const nextApplied = new Map<string, { revisionId: string; digests: Record<string, string>; keyEpoch: number }>();
    let objects = 0;
    let bytes = 0;

    const keysByNamespace = new Map<string, { encryptionKey: Uint8Array; dedupKey: Uint8Array }>();
    const encodedByNamespace = new Map<string, {
      entries: NamespaceManifestV1["entries"];
      plaintextChunks: Map<string, Uint8Array>;
      streamedFiles: Map<string, ScannedEntry>;
      digests: Record<string, string>;
    }>();
    for (const mapping of writable) {
      const keys = await this.#scopeKeys(mapping.namespace);
      keysByNamespace.set(mapping.namespace, keys);
      encodedByNamespace.set(mapping.namespace, { entries: [], plaintextChunks: new Map(), streamedFiles: new Map(), digests: {} });
    }
    for (const file of scanned) {
      const encoded = encodedByNamespace.get(file.namespace)!;
      const keys = keysByNamespace.get(file.namespace)!;
      const objectIds: string[] = [];
      let contentDigest: string;
      if (file.stagedPath) {
        const described = await describeStagedJsonl(file.stagedPath, keys.dedupKey, JSONL_CHUNK_POLICY);
        objectIds.push(...described.objectIds);
        contentDigest = described.contentDigest;
        encoded.streamedFiles.set(file.logicalPath, file);
      } else {
        const fileBytes = requiredMemoryBytes(file);
        for (const chunk of chunkBytes(fileBytes, CHUNK_POLICY)) {
          const objectId = await computeObjectId(keys.dedupKey, chunk);
          objectIds.push(objectId);
          if (!encoded.plaintextChunks.has(objectId)) encoded.plaintextChunks.set(objectId, chunk);
        }
        contentDigest = await computeObjectId(keys.dedupKey, fileBytes);
      }
      encoded.digests[file.logicalPath] = await computeNativeSnapshotDigest(keys.dedupKey, file);
      encoded.entries.push({
        namespace: file.namespace,
        keyEpoch: this.keyEpoch,
        logicalPath: file.logicalPath,
        entryType: file.entryType ?? "file",
        ...(file.workspacePath ? { workspacePath: file.workspacePath } : {}),
        ...(file.workspaceLayer ? { workspaceLayer: file.workspaceLayer } : {}),
        ...(file.fileMode !== undefined ? { fileMode: file.fileMode } : {}),
        objectIds,
        totalSize: file.stagedSize ?? requiredMemoryBytes(file).byteLength,
        contentDigest,
        chunking: file.stagedPath
          ? { strategy: "jsonl-records", ...JSONL_CHUNK_POLICY }
          : CHUNK_POLICY,
      });
    }
    const remoteManifests = new Map<string, NamespaceManifestV1>();
    for (const mapping of [...writable, ...memoryMappings(config).filter((mapping) => mapping.mode === "consume")]) {
      const head = heads.get(mapping.namespace);
      if (head) remoteManifests.set(mapping.namespace, (await this.#resolveNamespaceManifest(head)).manifest);
      if (head && mapping.memory) {
        const descriptors = remoteManifests.get(mapping.namespace)!.entries.filter((entry) => entry.logicalPath === MEMORY_DESCRIPTOR_PATH);
        if (descriptors.length !== 1) throw new MemoryIdentityError();
        const entry = descriptors[0]!, expected = encoder.encode(memoryDescriptor(mapping));
        const keys = await this.#scopeKeys(mapping.namespace, entry.keyEpoch ?? 1);
        try {
          if (entry.entryType !== "file" || entry.totalSize !== expected.byteLength || entry.contentDigest !== await computeObjectId(keys.dedupKey, expected)) throw new MemoryIdentityError();
        } finally { expected.fill(0); keys.encryptionKey.fill(0); keys.dedupKey.fill(0); }
      }
    }
    const baseManifests = new Map<string, NamespaceManifestV1 | undefined>();
    for (const mapping of writable) {
      const namespace = mapping.namespace;
      const head = heads.get(namespace);
      const remoteManifest = remoteManifests.get(namespace);
      const appliedRevisionId = config.applied[namespace]?.revisionId;
      let baseManifest = remoteManifest;
      if (!options.resolveLocalNamespaces?.has(namespace) && head && appliedRevisionId !== head.revisionId) {
        if (!appliedRevisionId) throw new SyncConflict([`${namespace}:remote-head-not-applied`]);
        try {
          const pointer = await this.client.namespaceRevision(this.vaultId, namespace, appliedRevisionId);
          baseManifest = (await this.#resolveNamespaceManifest(pointer)).manifest;
        } catch {
          throw new SyncConflict([`${namespace}:base-revision-unavailable`]);
        }
      }
      baseManifests.set(namespace, baseManifest);
    }

    const appendMergedPaths = new Map<string, Set<string>>();
    if (!this.scopedAccess) {
      for (const file of scanned.filter((candidate) => candidate.session)) {
        const namespace = file.namespace;
        const baseManifest = baseManifests.get(namespace);
        const remoteManifest = remoteManifests.get(namespace);
        const encoded = encodedByNamespace.get(namespace);
        const keys = keysByNamespace.get(namespace);
        if (!baseManifest || !remoteManifest || !encoded || !keys) continue;
        const baseEntry = baseManifest.entries.find((entry) => entry.logicalPath === file.logicalPath && entry.entryType === "file");
        const remoteEntry = remoteManifest.entries.find((entry) => entry.logicalPath === file.logicalPath && entry.entryType === "file");
        const localIndex = encoded.entries.findIndex((entry) => entry.logicalPath === file.logicalPath && entry.entryType === "file");
        const localEntry = encoded.entries[localIndex];
        if (!baseEntry || !remoteEntry || !localEntry ||
            baseEntry.contentDigest === remoteEntry.contentDigest ||
            baseEntry.contentDigest === localEntry.contentDigest ||
            remoteEntry.contentDigest === localEntry.contentDigest) continue;
        const merged = await this.#mergeStagedSessionAppend(baseEntry, remoteEntry, file, keys, config);
        if (!merged) continue;
        const previousDispose = file.dispose!;
        file.stagedPath = merged.path;
        file.stagedSize = merged.size;
        file.dispose = async () => {
          await Promise.all([previousDispose(), merged.dispose()]);
        };
        file.session!.activity = merged.activity;
        encoded.entries[localIndex] = {
          ...localEntry,
          objectIds: merged.objectIds,
          totalSize: merged.size,
          contentDigest: merged.contentDigest,
          chunking: { strategy: "jsonl-records", ...JSONL_CHUNK_POLICY },
        };
        encoded.digests[file.logicalPath] = merged.contentDigest;
        const paths = appendMergedPaths.get(namespace) ?? new Set<string>();
        paths.add(file.logicalPath);
        appendMergedPaths.set(namespace, paths);
      }
    }
    const previousManifest: VaultManifestV1 | undefined = remoteManifests.size === 0 ? undefined : {
      schemaVersion: 1,
      vaultId: this.vaultId,
      revisionId: remote.revisionId ?? "scoped_base",
      parentRevisionIds: [],
      createdAt,
      createdByDeviceId,
      operationId,
      entries: [...remoteManifests.values()].flatMap((manifest) => manifest.entries),
      tombstones: [...remoteManifests.values()].flatMap((manifest) => manifest.tombstones),
      conflicts: [...remoteManifests.values()].flatMap((manifest) => manifest.conflicts),
      sessionCapsules: [...remoteManifests.values()].flatMap((manifest) => manifest.sessionCapsules ?? []),
    };
    const capsuleEntries = [
      ...[...encodedByNamespace.values()].flatMap((encoded) => encoded.entries),
      ...memoryMappings(config).filter((mapping) => mapping.mode === "consume")
        .flatMap((mapping) => remoteManifests.get(mapping.namespace)?.entries ?? []),
    ];
    const sessionCapsules = await buildSessionCapsules({
      vaultId: this.vaultId,
      revisionId: vaultRevisionId,
      createdAt,
      createdByDeviceId,
      config,
      scanned,
      entries: capsuleEntries,
      previous: previousManifest,
    });

    for (const mapping of writable) {
      const namespace = mapping.namespace;
      const head = heads.get(namespace);
      const remoteManifest = remoteManifests.get(namespace);
      const baseManifest = baseManifests.get(namespace);
      const baseEntries = new Map((baseManifest?.entries ?? []).map((entry) => [entry.logicalPath, entry]));
      const encoded = encodedByNamespace.get(namespace)!;
      const localEntries = encoded.entries;
      const plaintextChunks = encoded.plaintextChunks;
      const streamedFiles = encoded.streamedFiles;
      const keys = keysByNamespace.get(namespace)!;
      const digests = encoded.digests;
      const localPaths = new Set(localEntries.map((entry) => entry.logicalPath));
      const localTombstones = [...baseEntries.values()]
        .filter((entry) => !localPaths.has(entry.logicalPath))
        .map((entry) => ({ namespace, logicalPath: entry.logicalPath, deletedAt: createdAt }));
      const originalEntries = new Map<NamespaceManifestV1["entries"][number], NamespaceManifestV1["entries"][number]>();
      const compareEntriesAtCurrentEpoch = async (entries: NamespaceManifestV1["entries"]): Promise<NamespaceManifestV1["entries"]> => {
        const compared = [];
        for (const entry of entries) {
          const comparable = await this.#entryAtCurrentDigest(entry);
          originalEntries.set(comparable, entry);
          compared.push(comparable);
        }
        return compared;
      };
      const baseState: NamespaceState = { entries: await compareEntriesAtCurrentEpoch(baseManifest?.entries ?? []), tombstones: baseManifest?.tombstones ?? [] };
      const remoteState: NamespaceState = { entries: remoteManifest?.entries ?? [], tombstones: remoteManifest?.tombstones ?? [] };
      const comparableRemoteState = { ...remoteState, entries: await compareEntriesAtCurrentEpoch(remoteState.entries) };
      const remoteObjectIds = new Set(remoteState.entries.flatMap((entry) => entry.objectIds));
      const localState = { entries: localEntries, tombstones: localTombstones };
      if (mapping.mode === "append") {
        const violations = appendOnlyViolations(baseState, localState);
        if (violations.length > 0) throw new SyncConflict(violations.map((path) => `${namespace}:${path}:append-only`));
      }
      const mergeRemoteState = maskMergedAppendPaths(comparableRemoteState, baseState, appendMergedPaths.get(namespace));
      const merged = mergeNamespace(baseState, mergeRemoteState, localState, { atomic: namespace.startsWith("workspace:") });
      if (merged.outcome === "conflict") throw new SyncConflict(merged.paths.map((path) => `${namespace}:${path}`));
      const finalState = merged.state;
      for (let index = 0; index < finalState.entries.length; index += 1) {
        const original = originalEntries.get(finalState.entries[index]!);
        if (!original || (original.keyEpoch ?? 1) === this.keyEpoch) continue;
        const rekeyed = await this.#rekeyEntry(original, dryRun);
        finalState.entries[index] = rekeyed;
        for (const objectId of rekeyed.objectIds) remoteObjectIds.add(objectId);
      }
      const remoteEntries = new Map(remoteState.entries.map((entry) => [entry.logicalPath, entry]));
      const finalEntries = new Map(finalState.entries.map((entry) => [entry.logicalPath, entry]));
      const changedEntries = finalState.entries.filter((entry) => remoteEntries.get(entry.logicalPath)?.contentDigest !== entry.contentDigest);
      const tombstones = remoteState.entries
        .filter((entry) => !finalEntries.has(entry.logicalPath))
        .map((entry) => finalState.tombstones.find((item) => item.logicalPath === entry.logicalPath) ?? { namespace, logicalPath: entry.logicalPath, deletedAt: createdAt });
      if (appendOnly && [...changedEntries, ...tombstones].some((entry) => isInstructionAuthorityPath(namespace, entry.logicalPath))) {
        throw new InstructionError("INSTRUCTION_AUTHORITY_UNVERIFIED");
      }
      const namespaceCapsules = sessionCapsules.filter((capsule) => capsule.harness.namespace === namespace);
      const capsulesChanged = canonicalJson(namespaceCapsules) !== canonicalJson(remoteManifest?.sessionCapsules ?? []);
      if (changedEntries.length === 0 && tombstones.length === 0 && !capsulesChanged && (!head || (head.keyEpoch ?? 1) === this.keyEpoch)) {
        // A different namespace may commit nextApplied below. Remote-only
        // content is not hydrated merely because this namespace needs no push.
        if (head && !appendMergedPaths.has(namespace) && namespaceStateEquals(finalState, localState)) {
          nextApplied.set(namespace, { revisionId: head.revisionId, digests, keyEpoch: head.keyEpoch ?? 1 });
        }
        continue;
      }
      const namespaceRevisionId = randomId("nrev");
      const manifestMode = appendOnly && head && (head.keyEpoch ?? 1) === this.keyEpoch ? "delta" as const : "snapshot" as const;
      const manifestEntries = manifestMode === "delta" ? changedEntries : finalState.entries;
      const manifestTombstones = manifestMode === "delta" ? tombstones : finalState.tombstones;
      const pathClaims = await Promise.all([
        ...manifestEntries.map(async (entry) => ({
          pathId: await computePathId(keys.dedupKey, appendOnly ? `${operationId}\0${entry.logicalPath}` : entry.logicalPath),
          mutation: "add" as const,
        })),
        ...manifestTombstones.map(async (entry) => ({
          pathId: await computePathId(keys.dedupKey, appendOnly ? `${operationId}\0${entry.logicalPath}` : entry.logicalPath),
          mutation: appendOnly ? "add" as const : "delete" as const,
        })),
      ]);
      const manifest: NamespaceManifestV1 = namespaceManifestSchema.parse({
        schemaVersion: 1,
        vaultId: this.vaultId,
        namespace,
        keyEpoch: this.keyEpoch,
        namespaceRevisionId,
        parentNamespaceRevisionIds: head ? [head.revisionId] : [],
        createdAt,
        createdByDeviceId,
        operationId,
        mode: manifestMode,
        entries: manifestEntries,
        tombstones: manifestTombstones,
        conflicts: [],
        sessionCapsules: namespaceCapsules,
        pathClaims,
      });
      const requiredObjectIds = [...new Set([
        ...manifest.entries.flatMap((entry) => entry.objectIds),
        ...manifest.conflicts.flatMap((conflict) => conflict.variantObjectIds),
      ])];
      const pendingObjectIds = new Set(requiredObjectIds.filter((objectId) => !remoteObjectIds.has(objectId)));
      for (const objectId of pendingObjectIds) {
        const plaintext = plaintextChunks.get(objectId);
        if (!plaintext) continue;
        const envelope = await encryptEnvelope({
          plaintext,
          key: keys.encryptionKey,
          dedupKey: keys.dedupKey,
          context: { vaultId: this.vaultId, scopeId: namespace, compression: "none" },
        });
        objects += 1;
        bytes += envelope.byteLength;
        if (!dryRun) await this.client.putNamespaceObject(this.vaultId, namespace, objectId, envelope);
        pendingObjectIds.delete(objectId);
      }
      for (const entry of manifest.entries) {
        const source = streamedFiles.get(entry.logicalPath);
        if (!source?.stagedPath || pendingObjectIds.size === 0) continue;
        const requiredForSource = new Set(entry.objectIds.filter((objectId) => pendingObjectIds.has(objectId)));
        if (requiredForSource.size === 0) continue;
        const transferred = await uploadStagedJsonl({
          path: source.stagedPath,
          policy: JSONL_CHUNK_POLICY,
          requiredObjectIds: requiredForSource,
          keys,
          vaultId: this.vaultId,
          namespace,
          dryRun,
          putObject: (objectId, envelope) => this.client.putNamespaceObject(this.vaultId, namespace, objectId, envelope),
        });
        objects += transferred.objects;
        bytes += transferred.bytes;
        for (const objectId of requiredForSource) pendingObjectIds.delete(objectId);
      }
      if (pendingObjectIds.size > 0) throw new Error("manifest references local objects that could not be materialized");
      const manifestBytes = encoder.encode(canonicalJson(manifest));
      const manifestObjectId = await computeObjectId(keys.dedupKey, manifestBytes);
      const manifestEnvelope = await encryptEnvelope({
        plaintext: manifestBytes,
        key: keys.encryptionKey,
        dedupKey: keys.dedupKey,
        context: { vaultId: this.vaultId, scopeId: namespace, compression: "none" },
      });
      objects += 1;
      bytes += manifestEnvelope.byteLength;
      if (!dryRun) {
        await this.client.putNamespaceObject(this.vaultId, namespace, manifestObjectId, manifestEnvelope);
      }
      updates.push({
        namespace,
        keyEpoch: this.keyEpoch,
        baseNamespaceRevisionId: head?.revisionId ?? null,
        namespaceRevisionId,
        manifestObjectId,
        requiredObjectIds,
        ...(manifest.sessionCapsules?.length
          ? { retainedVaultRevisionIds: capsuleRetentionRoots(manifest.sessionCapsules) }
          : {}),
        mode: appendOnly ? "append" as const : "replace" as const,
        pathClaims,
      });
      if (!appendMergedPaths.has(namespace) && namespaceStateEquals(finalState, localState)) {
        nextApplied.set(namespace, { revisionId: namespaceRevisionId, digests, keyEpoch: this.keyEpoch });
      }
    }
    if (updates.length === 0) {
      if (!dryRun) recordSessionBindings(config, writable, scanned);
      return { outcome: "unchanged", revisionId: remote.revisionId, files: 0, objects: 0, bytes: 0 };
    }
    if (!dryRun) {
      await this.client.commitNamespaces(this.vaultId, { protocolVersion: "1.1", operationId, vaultRevisionId, updates });
      for (const [namespace, applied] of nextApplied) config.applied[namespace] = applied;
      recordSessionBindings(config, writable, scanned);
    }
    return { outcome: "pushed", revisionId: vaultRevisionId, files: scanned.length, objects, bytes };
    } finally {
      await Promise.all(scanned.flatMap((entry) => entry.dispose ? [entry.dispose()] : []));
    }
  }

  async hydrate(
    config: LocalConfig,
    sessionCapsuleId: string,
    options: { mode?: "strict" | "warn" | "best-effort"; dryRun?: boolean } = {},
  ): Promise<{ result: SyncResult; report: DependencyReport; warnings: string[] }> {
    const mode = options.mode ?? "warn";
    const report = (await this.dependencies()).find((candidate) => candidate.sessionCapsuleId === sessionCapsuleId);
    if (!report) throw new Error(`session capsule not found: ${sessionCapsuleId}`);
    const pinnedRevisions = new Set([
      report.harnessRevisionId,
      report.workspace.capsuleRevisionId,
      ...report.drops.map((drop) => drop.revisionId),
      ...(report.memories ?? []).map((memory) => memory.revisionId),
    ]);

    const warnings = report.dependencies
      .filter((dependency) => dependency.required && dependency.status === "unresolved")
      .map((dependency) => dependency.logicalPath);
    const harnessMapping = config.mappings.find((mapping) => mapping.namespace === report.harness.namespace);
    if (!harnessMapping) warnings.push(`mapping:${report.harness.namespace}`);
    const workspace = config.workspaces.find((candidate) => candidate.id === report.workspace.workspaceId);
    if (!workspace) warnings.push(`mapping:workspace:${report.workspace.workspaceId}`);
    const dropIds = new Set(report.drops.map((drop) => drop.dropId));
    for (const dropId of dropIds) {
      if (!config.mappings.some((mapping) => mapping.kind === "drop" && mapping.id === dropId)) warnings.push(`mapping:drop:${dropId}`);
    }
    const memoryIds = new Set((report.memories ?? []).map((memory) => memory.memoryId));
    const selectedMemories = (config.memories ?? []).filter((memory) => memoryIds.has(memory.id));
    for (const memoryId of memoryIds) {
      if (!selectedMemories.some((memory) => memory.id === memoryId)) warnings.push(`mapping:memory:${memoryId}`);
    }
    if (selectedMemories.some((memory) => memory.harnessNamespace !== report.harness.namespace ||
        (memory.kind === "claude-project" && memory.workspaceId !== report.workspace.workspaceId))) throw new MemoryIdentityError();
    warnings.sort((left, right) => left.localeCompare(right, "en"));
    if (mode === "strict" && warnings.length > 0) throw new SessionDependencyError(warnings);

    const scoped = structuredClone(config);
    scoped.applied = {};
    scoped.mappings = config.mappings
      .filter((mapping) => mapping.namespace === report.harness.namespace || (mapping.kind === "drop" && dropIds.has(mapping.id)))
      .map((mapping) => ({ ...mapping, mode: "consume" as const }));
    scoped.workspaces = workspace ? [{ ...workspace, sync: "git" }] : [];
    scoped.memories = selectedMemories.map((memory) => ({ ...memory, mode: "consume" as const }));
    this.#materializationOwners.set(scoped, this.#materializationOwners.get(config) ?? config);
    try {
      const result = pinnedRevisions.size === 1
        ? await this.pull(scoped, options.dryRun ?? false, [...pinnedRevisions][0]!)
        : await this.#hydratePinnedNamespaces(scoped, report, options.dryRun ?? false);
      if (!options.dryRun) {
        for (const [namespace, applied] of Object.entries(scoped.applied)) config.applied[namespace] = applied;
        config.sessionBindings = scoped.sessionBindings;
      }
      return { result, report, warnings };
    } finally { this.#materializationOwners.delete(scoped); }
  }

  async #hydratePinnedNamespaces(
    config: LocalConfig,
    report: DependencyReport,
    dryRun: boolean,
  ): Promise<SyncResult> {
    const pins = new Map<string, string>();
    const addPin = (namespace: string, revisionId: string): void => {
      const existing = pins.get(namespace);
      if (existing && existing !== revisionId) throw new Error(`session capsule has conflicting pins for namespace ${namespace}`);
      pins.set(namespace, revisionId);
    };
    addPin(report.harness.namespace, report.harnessRevisionId);
    addPin(`workspace:${report.workspace.workspaceId}`, report.workspace.capsuleRevisionId);
    for (const drop of report.drops) addPin(`drop:${drop.dropId}`, drop.revisionId);
    for (const memory of report.memories ?? []) addPin(`memory:${memory.memoryId}`, memory.revisionId);

    const selected = [...syncRootMappings(config).filter((mapping) => mapping.mode !== "publish"), ...workspaceMappings(config)];
    const selectedNamespaces = new Set(selected.map((mapping) => mapping.namespace));
    const pointers = new Map<string, Awaited<ReturnType<StatecaseClient["scopedRevision"]>>>();
    const entries: VaultManifestV1["entries"] = [];
    const tombstones: VaultManifestV1["tombstones"] = [];
    const conflicts: VaultManifestV1["conflicts"] = [];
    const sessionCapsules = new Map<string, SessionCapsuleV1>();
    const appliedRevisions = new Map<string, string>();
    const appliedKeyEpochs = new Map<string, number>();
    let manifestObjects = 0;

    for (const [namespace, revisionId] of pins) {
      if (!selectedNamespaces.has(namespace)) continue;
      let pointer = pointers.get(revisionId);
      if (!pointer) {
        pointer = await this.client.scopedRevision(this.vaultId, revisionId);
        if (pointer.revisionId !== revisionId) throw new Error("pinned scoped revision does not match its request");
        pointers.set(revisionId, pointer);
      }
      const head = pointer.namespaces.find((candidate) => candidate.namespace === namespace);
      if (!head) throw new Error(`pinned namespace revision is unavailable: ${namespace}`);
      const resolved = await this.#resolveNamespaceManifest(head);
      manifestObjects += resolved.manifestObjects;
      appliedRevisions.set(namespace, head.revisionId);
      appliedKeyEpochs.set(namespace, head.keyEpoch ?? 1);
      entries.push(...resolved.manifest.entries);
      tombstones.push(...resolved.manifest.tombstones);
      conflicts.push(...resolved.manifest.conflicts);
      for (const capsule of resolved.manifest.sessionCapsules ?? []) {
        sessionCapsules.set(capsule.sessionKey, capsule);
      }
    }

    const combined: VaultManifestV1 = {
      schemaVersion: 1,
      vaultId: this.vaultId,
      revisionId: report.harnessRevisionId,
      parentRevisionIds: [],
      createdAt: report.createdAt,
      createdByDeviceId: report.createdByDeviceId,
      operationId: `hydrate_${report.sessionCapsuleId}`,
      entries: entries.sort(compareEntries),
      tombstones: tombstones.sort((left, right) => left.namespace.localeCompare(right.namespace, "en") || left.logicalPath.localeCompare(right.logicalPath, "en")),
      conflicts,
      sessionCapsules: [...sessionCapsules.values()].sort((left, right) => left.sessionKey.localeCompare(right.sessionKey, "en")),
    };
    return this.#materializeManifest(
      config,
      dryRun,
      report.harnessRevisionId,
      combined,
      selected,
      manifestObjects,
      (namespace, objectId) => this.client.getNamespaceObject(this.vaultId, namespace, objectId),
      (namespace) => {
        const revisionId = appliedRevisions.get(namespace);
        if (!revisionId) throw new Error(`pinned namespace revision is unavailable: ${namespace}`);
        return revisionId;
      },
      (namespace) => appliedKeyEpochs.get(namespace) ?? 1,
    );
  }

  async pull(config: LocalConfig, dryRun = false, historicalRevisionId?: string): Promise<SyncResult> {
    if (this.scopedAccess) return this.#pullScoped(config, dryRun, historicalRevisionId);
    if (historicalRevisionId) {
      try {
        return await this.#pullScoped(config, dryRun, historicalRevisionId);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
    }
    if (!historicalRevisionId && (await this.client.namespaceHeads(this.vaultId)).namespaces.length > 0) {
      return this.#pullScoped(config, dryRun);
    }
    const head = historicalRevisionId
      ? await this.client.revision(this.vaultId, historicalRevisionId)
      : await this.client.head(this.vaultId);
    if (!head.revisionId || !head.manifestObjectId) return { outcome: "unchanged", revisionId: null, files: 0, objects: 0, bytes: 0 };
    const selected = [...syncRootMappings(config).filter((mapping) => mapping.mode !== "publish"), ...workspaceMappings(config)];
    if (!historicalRevisionId && selected.length > 0 && selected.every((mapping) => config.applied[mapping.namespace]?.revisionId === head.revisionId)) {
      return { outcome: "unchanged", revisionId: head.revisionId, files: 0, objects: 0, bytes: 0 };
    }
    const manifest = await this.#downloadManifest(head.manifestObjectId);
    if (manifest.revisionId !== head.revisionId) throw new Error("remote head and manifest revision do not match");
    return this.#materializeManifest(config, dryRun, head.revisionId, manifest, selected, 1,
      (_namespace, objectId) => this.client.getObject(this.vaultId, objectId),
      () => head.revisionId!,
      () => 1);
  }

  async restoreInPlace(
    config: LocalConfig,
    mapping: RootMapping,
    historicalRevisionId: string,
    options: InPlaceRestoreOptions = {},
  ): Promise<InPlaceRestoreResult> {
    if (!this.vaultKey) throw new Error("in-place restore requires a full-key device");
    const workspaceId = workspaceMappingId(mapping);
    const configured = workspaceId
      ? workspaceMappings(config).find((candidate) => candidate.id === mapping.id)
      : syncRootMappings(config).find((candidate) => candidate.id === mapping.id);
    if (!configured || configured.namespace !== mapping.namespace || configured.kind !== mapping.kind || configured.mode !== mapping.mode ||
        resolve(configured.path) !== resolve(mapping.path) || canonicalJson(configured.memory ?? null) !== canonicalJson(mapping.memory ?? null)) {
      throw new Error("in-place restore mapping does not match this device");
    }
    if (mapping.mode !== "two-way") throw new Error("in-place restore requires a two-way mapping");
    const targetRootInfo = await lstat(resolve(mapping.path));
    if (!targetRootInfo.isDirectory() || targetRootInfo.isSymbolicLink()) {
      throw new Error("in-place restore target root must be a real directory");
    }
    const dryRun = options.dryRun ?? false;
    if (!dryRun && !options.prepareRecovery) throw new Error("in-place restore requires persistent recovery preparation");
    const remote = await this.client.namespaceHeads(this.vaultId);
    if (!remote.revisionId) throw new Error("in-place restore requires a scoped vault revision");
    const historical = await this.client.scopedRevision(this.vaultId, historicalRevisionId);
    const currentHead = remote.namespaces.find((head) => head.namespace === mapping.namespace);
    const historicalHead = historical.namespaces.find((head) => head.namespace === mapping.namespace);
    if (!currentHead || !historicalHead) throw new Error(`namespace is unavailable in the selected revision: ${mapping.namespace}`);
    const current = (await this.#resolveNamespaceManifest(currentHead)).manifest;
    const target = (await this.#resolveNamespaceManifest(historicalHead)).manifest;
    if ((target.conflicts?.length ?? 0) > 0) throw new Error("in-place restore refuses a revision with unresolved conflicts");

    const workingConfig = structuredClone(config);
    const local = workspaceId ? [] : await scanWritableMappings([mapping], workingConfig.workspaces, true, memoryMappings(workingConfig));
    let materialized = false;
    let recovery: { rollback(): Promise<void> } | undefined;
    try {
      recordSessionBindings(workingConfig, [mapping], local);
      const desiredPaths = new Set(target.entries.map((entry) => entry.logicalPath));
      const tombstones = new Map(target.tombstones.map((tombstone) => [tombstone.logicalPath, tombstone]));
      const deletedAt = new Date().toISOString();
      for (const tombstone of current.tombstones) {
        if (!desiredPaths.has(tombstone.logicalPath) && !tombstones.has(tombstone.logicalPath)) {
          tombstones.set(tombstone.logicalPath, tombstone);
        }
      }
      for (const logicalPath of [
        ...current.entries.map((entry) => entry.logicalPath),
        ...local.map((entry) => entry.logicalPath),
      ]) {
        if (!desiredPaths.has(logicalPath)) tombstones.set(logicalPath, { namespace: mapping.namespace, logicalPath, deletedAt });
      }
      for (const logicalPath of desiredPaths) tombstones.delete(logicalPath);
      const combined: VaultManifestV1 = {
        schemaVersion: 1,
        vaultId: this.vaultId,
        revisionId: historicalRevisionId,
        parentRevisionIds: [],
        createdAt: target.createdAt,
        createdByDeviceId: target.createdByDeviceId,
        operationId: target.operationId,
        entries: target.entries,
        tombstones: [...tombstones.values()].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, "en")),
        conflicts: [],
        sessionCapsules: target.sessionCapsules ?? [],
      };
      const pulled = await this.#materializeManifest(
        workingConfig,
        dryRun,
        historicalRevisionId,
        combined,
        [mapping],
        1,
        (namespace, objectId) => this.client.getNamespaceObject(this.vaultId, namespace, objectId),
        () => historicalHead.revisionId,
        () => historicalHead.keyEpoch ?? 1,
        {
          allowLocalOverwrite: true,
          ...(workspaceId ? {
            replaceWorkspaces: true,
            prepareWorkspaceRecovery: async (plan: { paths: string[]; targetHeadRef: string | null }) => {
              await assertRestoreTransactionSafe(mapping.path, plan.paths);
              recovery = await options.prepareRecovery!(plan.paths, { kind: "workspace", targetHeadRef: plan.targetHeadRef });
              materialized = true;
            },
          } : {}),
          ...(!dryRun ? {
            materialize: workspaceId ? applyFileTransaction : async (transaction) => {
              const paths = transactionTargets(transaction);
              await assertRestoreTransactionSafe(mapping.path, paths);
              recovery = await options.prepareRecovery!(paths);
              await applyFileTransaction(transaction);
              materialized = true;
            },
          } : {}),
        },
      );
      if (dryRun) {
        return {
          ...pulled,
          dryRun: true,
          historicalRevisionId,
          namespace: mapping.namespace,
          namespaceRevisionId: historicalHead.revisionId,
        };
      }

      const validated = await scanWritableMappings([mapping], workingConfig.workspaces, true, memoryMappings(workingConfig));
      try {
        const actualPaths = new Set(validated.map((entry) => entry.logicalPath));
        if (actualPaths.size !== desiredPaths.size || [...desiredPaths].some((path) => !actualPaths.has(path))) {
          throw new Error("restored namespace failed adapter validation");
        }
        if (workspaceId) {
          const byPath = new Map(validated.map((entry) => [entry.logicalPath, entry]));
          for (const entry of target.entries) {
            const keys = await this.#scopeKeys(mapping.namespace, entry.keyEpoch ?? 1);
            const actual = byPath.get(entry.logicalPath);
            if (!actual?.bytes || await computeObjectId(keys.dedupKey, actual.bytes) !== entry.contentDigest) {
              throw new Error("restored workspace failed capsule validation");
            }
          }
        } else {
          const keys = await this.#scopeKeys(mapping.namespace, historicalHead.keyEpoch ?? 1);
          for (const entry of target.entries) {
            const expected = workingConfig.applied[mapping.namespace]?.digests[entry.logicalPath];
            const projected = mapping.memory || settingsField(mapping.kind, entry.logicalPath)
              ? validated.find((candidate) => candidate.logicalPath === entry.logicalPath)?.bytes : undefined;
            const actual = projected ? await computeObjectId(keys.dedupKey, projected)
              : await optionalFileDigest(sessionDestination(mapping, entry.logicalPath, workingConfig), keys);
            if (!expected || actual !== expected) {
              throw new Error("restored namespace failed content validation");
            }
          }
        }
      } finally {
        await Promise.all(validated.flatMap((entry) => entry.dispose ? [entry.dispose()] : []));
      }

      const operationId = randomId("op");
      const namespaceRevisionId = randomId("nrev");
      const vaultRevisionId = randomId("srev");
      const createdAt = new Date().toISOString();
      const createdByDeviceId = workingConfig.deviceId ?? (workingConfig.deviceName ? safeIdentifier(workingConfig.deviceName, "device") : "device_unknown");
      const keys = await this.#scopeKeys(mapping.namespace);
      const restoredEntries = [];
      for (const entry of target.entries) restoredEntries.push(await this.#rekeyEntry(entry));
      const currentPaths = new Set(current.entries.map((entry) => entry.logicalPath));
      const pathClaims = [
        ...target.entries.map((entry) => ({
          pathId: "",
          logicalPath: entry.logicalPath,
          mutation: currentPaths.has(entry.logicalPath) ? "update" as const : "add" as const,
        })),
        ...combined.tombstones.map((tombstone) => ({ pathId: "", logicalPath: tombstone.logicalPath, mutation: "delete" as const })),
      ];
      for (const claim of pathClaims) claim.pathId = await computePathId(keys.dedupKey, claim.logicalPath);
      const restoredManifest = namespaceManifestSchema.parse({
        schemaVersion: 1,
        vaultId: this.vaultId,
        namespace: mapping.namespace,
        keyEpoch: this.keyEpoch,
        namespaceRevisionId,
        parentNamespaceRevisionIds: [currentHead.revisionId],
        createdAt,
        createdByDeviceId,
        operationId,
        mode: "snapshot",
        entries: restoredEntries,
        tombstones: combined.tombstones,
        conflicts: [],
        sessionCapsules: target.sessionCapsules ?? [],
        pathClaims: pathClaims.map(({ pathId, mutation }) => ({ pathId, mutation })),
      });
      const manifestBytes = encoder.encode(canonicalJson(restoredManifest));
      const manifestObjectId = await computeObjectId(keys.dedupKey, manifestBytes);
      const manifestEnvelope = await encryptEnvelope({
        plaintext: manifestBytes,
        key: keys.encryptionKey,
        dedupKey: keys.dedupKey,
        context: { vaultId: this.vaultId, scopeId: mapping.namespace, compression: "none" },
      });
      await this.client.putNamespaceObject(this.vaultId, mapping.namespace, manifestObjectId, manifestEnvelope);
      const requiredObjectIds = [...new Set(restoredEntries.flatMap((entry) => entry.objectIds))];
      if (!workspaceId) {
        for (const entry of restoredEntries) {
          workingConfig.applied[mapping.namespace]!.digests[entry.logicalPath] =
            mapping.memory || settingsField(mapping.kind, entry.logicalPath) ? entry.contentDigest
              : (await optionalFileDigest(sessionDestination(mapping, entry.logicalPath, workingConfig), keys))!;
        }
      }
      const committed = await this.client.commitNamespaces(this.vaultId, {
        protocolVersion: "1.1",
        operationId,
        vaultRevisionId,
        updates: [{
          namespace: mapping.namespace,
          keyEpoch: this.keyEpoch,
          baseNamespaceRevisionId: currentHead.revisionId,
          namespaceRevisionId,
          manifestObjectId,
          requiredObjectIds,
          ...(restoredManifest.sessionCapsules?.length
            ? { retainedVaultRevisionIds: capsuleRetentionRoots(restoredManifest.sessionCapsules) }
            : {}),
          mode: "replace",
          pathClaims: restoredManifest.pathClaims,
        }],
      });
      workingConfig.applied[mapping.namespace]!.revisionId = namespaceRevisionId;
      workingConfig.applied[mapping.namespace]!.keyEpoch = this.keyEpoch;
      config.applied[mapping.namespace] = workingConfig.applied[mapping.namespace]!;
      config.sessionBindings = workingConfig.sessionBindings;
      return {
        ...pulled,
        revisionId: committed.revisionId,
        dryRun: false,
        historicalRevisionId,
        namespace: mapping.namespace,
        namespaceRevisionId,
      };
    } catch (error) {
      if (materialized && recovery) {
        try {
          await recovery.rollback();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "in-place restore failed and emergency rollback was incomplete");
        }
      }
      throw error;
    } finally {
      await Promise.all(local.flatMap((entry) => entry.dispose ? [entry.dispose()] : []));
    }
  }

  async #materializeManifest(
    config: LocalConfig,
    dryRun: boolean,
    remoteRevisionId: string,
    manifest: VaultManifestV1,
    selected: RootMapping[],
    manifestObjectCount: number,
    getObject: (namespace: string, objectId: string) => Promise<Uint8Array>,
    appliedRevision: (namespace: string) => string,
    appliedKeyEpoch: (namespace: string) => number,
    options: MaterializationOptions = {},
  ): Promise<SyncResult> {
    const byNamespace = new Map(selected.map((mapping) => [mapping.namespace, mapping]));
    const memoryRoots = memoryMappings(config);
    const materialized: MaterializedEntry[] = [];
    const deletions: Array<{ mapping: RootMapping; path: string; logicalPath: string }> = [];
    const workspacePayloads = new Map<string, { mapping: RootMapping; capsule?: CapturedWorkspace["capsule"]; blobs: WorkspaceBlob[] }>();
    const incompleteNamespaces = new Set<string>();
    const incomingSettings: IncomingSetting[] = [];
    const incomingInstructions: IncomingInstruction[] = [];
    const incomingMemory: IncomingNativeText[] = [];
    const memoryBounds = new Map<string, { files: number; bytes: number }>();
    let memoryPlan: NativeTextPlan | undefined;
    const instructionBounds = new Map<string, { files: number; bytes: number }>();
    let instructionPlan: InstructionPlan | undefined;
    let settingsPlan: SettingsPlan | undefined;
    let objectCount = manifestObjectCount;
    let byteCount = 0;
    const stagedDisposers: Array<() => Promise<void>> = [];
    try {
    for (const entry of manifest.entries) {
      const mapping = byNamespace.get(entry.namespace);
      if (!mapping) continue;
      assertRemotePathAllowed(mapping, entry.logicalPath);
      const field = settingsField(mapping.kind, entry.logicalPath);
      const instruction = instructionPath(mapping.kind, entry.logicalPath);
      if (mapping.memory) {
        const bounds = memoryBounds.get(entry.namespace) ?? { files: 0, bytes: 0 };
        bounds.files++; bounds.bytes += entry.totalSize; memoryBounds.set(entry.namespace, bounds);
        const limit = entry.logicalPath === MEMORY_DESCRIPTOR_PATH ? 4096 : MAX_MEMORY_FILE_BYTES;
        if (entry.entryType !== "file" || entry.totalSize > limit || entry.objectIds.length > 256 || entry.chunking?.strategy === "jsonl-records" ||
            entry.workspacePath !== undefined || entry.workspaceLayer !== undefined || entry.fileMode !== undefined || bounds.files > MAX_MEMORY_FILES + 1 || bounds.bytes > MAX_MEMORY_SET_BYTES + 4096) throw new MemoryFormatError();
      }
      if (instruction) {
        const bounds = instructionBounds.get(entry.namespace) ?? { files: 0, bytes: 0 };
        bounds.files++; bounds.bytes += entry.totalSize; instructionBounds.set(entry.namespace, bounds);
        if (entry.entryType !== "file" || entry.totalSize > MAX_INSTRUCTION_BYTES || entry.objectIds.length > 256 || entry.chunking?.strategy === "jsonl-records" ||
            entry.workspacePath !== undefined || entry.workspaceLayer !== undefined || entry.fileMode !== undefined || bounds.files > MAX_INSTRUCTION_FILES || bounds.bytes > MAX_INSTRUCTION_SET_BYTES) {
          throw new InstructionError("INSTRUCTION_FORMAT_INVALID");
        }
      }
      if (field && (entry.entryType !== "file" || entry.totalSize > MAX_SETTING_BYTES || entry.objectIds.length > 1 || entry.chunking?.strategy === "jsonl-records" || entry.workspacePath !== undefined || entry.workspaceLayer !== undefined || entry.fileMode !== undefined)) {
        throw new Error("remote portable setting metadata is invalid");
      }
      const keys = await this.#scopeKeys(entry.namespace, entry.keyEpoch ?? 1);
      const portable = portableSession(entry.logicalPath);
      const streamedSession = mapping.kind !== "drop" && (portable !== undefined || entry.chunking?.strategy === "jsonl-records");
      if (streamedSession) {
        if (entry.totalSize > MAX_STREAMED_SESSION_BYTES) throw new Error(`remote file exceeds the local safety limit: ${entry.logicalPath}`);
        const workspace = portable
          ? config.workspaces.find((candidate) => candidate.id === portable.workspaceId)
          : undefined;
        if (portable && !workspace) {
          incompleteNamespaces.add(entry.namespace);
          continue;
        }
        const staged = await downloadVerifiedEntry({
          objectIds: entry.objectIds,
          totalSize: entry.totalSize,
          contentDigest: entry.contentDigest,
          maximumSize: MAX_STREAMED_SESSION_BYTES,
          keys,
          vaultId: this.vaultId,
          namespace: entry.namespace,
          getObject: (objectId) => getObject(entry.namespace, objectId),
          onEnvelope: (envelopeBytes) => {
            byteCount += envelopeBytes;
            objectCount += 1;
          },
        });
        stagedDisposers.push(staged.dispose);
        const nativePath = join(staged.root, "localized.jsonl");
        await localizePortableSession(staged.path, nativePath, portable?.workspaceId, workspace ? resolve(workspace.path) : undefined,
          { memories: sessionMemoryRoots(memoryRoots, mapping.namespace) });
        materialized.push({
          mapping,
          logicalPath: entry.logicalPath,
          path: sessionDestination(mapping, entry.logicalPath, config),
          sourcePath: nativePath,
          digest: await computeObjectIdStream(keys.dedupKey, createReadStream(nativePath)),
        });
        continue;
      }
      if (entry.totalSize > MAX_FILE_BYTES) throw new Error(`remote file exceeds the local safety limit: ${entry.logicalPath}`);
      const chunks: Uint8Array[] = [];
      let plaintextBytes = 0;
      for (const objectId of entry.objectIds) {
        const envelope = await getObject(entry.namespace, objectId);
        byteCount += envelope.byteLength;
        objectCount += 1;
        const chunk = await decryptEnvelope({
          envelope,
          key: keys.encryptionKey,
          dedupKey: keys.dedupKey,
          expected: { vaultId: this.vaultId, scopeId: entry.namespace, compression: "none" },
        });
        plaintextBytes += chunk.byteLength;
        if (plaintextBytes > MAX_FILE_BYTES || plaintextBytes > entry.totalSize) throw new Error("downloaded file exceeds its declared size");
        chunks.push(chunk);
      }
      let bytes = concatChunks(chunks);
      if (bytes.byteLength !== entry.totalSize || await computeObjectId(keys.dedupKey, bytes) !== entry.contentDigest) {
        throw new Error("downloaded file failed content verification");
      }
      if (field) {
        incomingSettings.push({ mapping, logicalPath: entry.logicalPath, field, bytes });
        continue;
      }
      if (instruction) { incomingInstructions.push({ mapping, logicalPath: entry.logicalPath, bytes }); continue; }
      if (mapping.memory) { incomingMemory.push({ mapping, logicalPath: entry.logicalPath, bytes }); continue; }
      if (mapping.id.startsWith("workspace_") && entry.entryType === "workspace-capsule") {
        const payload = workspacePayloads.get(entry.namespace) ?? { mapping, blobs: [] };
        payload.capsule = JSON.parse(new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(bytes)) as CapturedWorkspace["capsule"];
        workspacePayloads.set(entry.namespace, payload);
        continue;
      }
      if (mapping.id.startsWith("workspace_") && entry.entryType === "workspace-blob") {
        if (!entry.workspacePath || !entry.workspaceLayer || entry.fileMode === undefined) throw new Error("workspace blob metadata is incomplete");
        const payload = workspacePayloads.get(entry.namespace) ?? { mapping, blobs: [] };
        payload.blobs.push({
          layer: entry.workspaceLayer,
          path: entry.workspacePath,
          bytes,
          mode: entry.fileMode,
          oid: gitBlobOidFromLogicalPath(entry.logicalPath),
        });
        workspacePayloads.set(entry.namespace, payload);
        continue;
      }
      if (portable && mapping.kind !== "drop") {
        const workspace = config.workspaces.find((candidate) => candidate.id === portable.workspaceId);
        if (!workspace) continue;
        bytes = localizeSession(bytes, portable.workspaceId, resolve(workspace.path), sessionMemoryRoots(memoryRoots, mapping.namespace));
      } else if (mapping.kind !== "drop" && harnessClassification(mapping.kind, entry.logicalPath) === "session") {
        bytes = localizeSession(bytes, undefined, undefined, sessionMemoryRoots(memoryRoots, mapping.namespace));
      }
      const localDigest = await computeObjectId(keys.dedupKey, bytes);
      materialized.push({
        mapping,
        logicalPath: entry.logicalPath,
        path: sessionDestination(mapping, entry.logicalPath, config),
        bytes,
        digest: localDigest,
      });
    }
    for (const tombstone of manifest.tombstones) {
      const mapping = byNamespace.get(tombstone.namespace);
      if (!mapping) continue;
      assertRemotePathAllowed(mapping, tombstone.logicalPath);
      const field = settingsField(mapping.kind, tombstone.logicalPath);
      if (field) { incomingSettings.push({ mapping, logicalPath: tombstone.logicalPath, field }); continue; }
      if (instructionPath(mapping.kind, tombstone.logicalPath)) { incomingInstructions.push({ mapping, logicalPath: tombstone.logicalPath }); continue; }
      if (mapping.memory) { incomingMemory.push({ mapping, logicalPath: tombstone.logicalPath }); continue; }
      if (workspaceMappingId(mapping)) continue;
      const portable = portableSession(tombstone.logicalPath);
      if (portable && mapping.kind !== "drop" && !config.workspaces.some((candidate) => candidate.id === portable.workspaceId)) {
        incompleteNamespaces.add(tombstone.namespace);
        continue;
      }
      deletions.push({
        mapping,
        path: sessionDestination(mapping, tombstone.logicalPath, config),
        logicalPath: tombstone.logicalPath,
      });
    }

    const readyWorkspaces: Array<{ mapping: RootMapping; captured: CapturedWorkspace; gitFetch: GitFetchPolicy; expectedCurrent?: CapturedWorkspace }> = [];
    for (const payload of workspacePayloads.values()) {
      if (!payload.capsule) throw new Error("workspace capsule metadata is missing");
      const captured = { capsule: payload.capsule, blobs: payload.blobs };
      if (await workspaceMatchesCapsule(payload.mapping.path, captured)) continue;
      const workspaceId = payload.mapping.namespace.slice("workspace:".length);
      const gitFetch = config.workspaces.find((workspace) => workspace.id === workspaceId)?.gitFetch ?? "ask";
      let expectedCurrent: CapturedWorkspace | undefined;
      try {
        if (options.replaceWorkspaces) await assertWorkspaceReplacement(payload.mapping.path, captured, { gitFetch });
        else {
          try { await inspectWorkspaceDestination(payload.mapping.path, captured, gitFetch); }
          catch (error) {
            if (error instanceof WorkspaceBaselineUnavailable || error instanceof GitLfsContentUnavailable) throw error;
            expectedCurrent = await this.#verifiedAppliedWorkspace(config, payload.mapping);
            if (!expectedCurrent) throw error;
            await assertWorkspaceAdvance(payload.mapping.path, captured, expectedCurrent, gitFetch);
          }
        }
      } catch (error) {
        if (error instanceof WorkspaceBaselineUnavailable || error instanceof GitLfsContentUnavailable) throw error;
        throw new SyncConflict([payload.mapping.path]);
      }
      readyWorkspaces.push({ mapping: payload.mapping, captured, gitFetch, expectedCurrent });
    }

    settingsPlan = await prepareSettingsPlan(incomingSettings, config, appliedKeyEpoch,
      async (namespace, epoch, bytes) => computeObjectId((await this.#scopeKeys(namespace, epoch)).dedupKey, bytes));
    instructionPlan = await prepareInstructionPlan(incomingInstructions, config, appliedKeyEpoch,
      async (namespace, epoch, bytes) => computeObjectId((await this.#scopeKeys(namespace, epoch)).dedupKey, bytes));
    memoryPlan = await prepareMemoryPlan(incomingMemory, config, appliedKeyEpoch,
      async (namespace, epoch, bytes) => computeObjectId((await this.#scopeKeys(namespace, epoch)).dedupKey, bytes), selected.filter((mapping) => mapping.memory));
    assertDistinctMaterializationPaths([...materialized, ...settingsPlan.targets, ...instructionPlan.targets, ...memoryPlan.targets], deletions);
    const conflicts: string[] = [...settingsPlan.conflicts, ...instructionPlan.conflicts, ...memoryPlan.conflicts];
    const fileGuards = new Map<string, FileGuard>();
    const guardFile = async (item: { mapping: RootMapping; path: string }): Promise<FileGuard> => {
      try {
        const keys = await this.#scopeKeys(item.mapping.namespace, config.applied[item.mapping.namespace]?.keyEpoch ?? 1);
        const guard = await captureFileGuard(item.mapping.path, item.path, keys.dedupKey,
          { maximumBytes: item.mapping.kind === "drop" ? MAX_FILE_BYTES : MAX_STREAMED_SESSION_BYTES });
        fileGuards.set(resolve(item.path), guard);
        return guard;
      } catch { throw new SyncConflict([item.path]); }
    };
    for (const item of materialized) {
      const guard = await guardFile(item);
      if (item.sourcePath !== undefined) {
        const remoteSourcePath = item.sourcePath;
        const currentDigest = guard.digest;
        if (!currentDigest || currentDigest === item.digest) continue;
        const prior = config.applied[item.mapping.namespace]?.digests[item.logicalPath];
        if (currentDigest !== prior) {
          const memories = sessionMemoryRoots(memoryRoots, item.mapping.namespace);
          const workspaceId = portableSession(item.logicalPath)?.workspaceId;
          const safeSessionMerge = await isCompleteJsonlFileRecordSupersequence(item.path, remoteSourcePath, undefined, {
            local: createMemoryReferenceRewriter(memories, "portable", workspaceId),
            remote: createMemoryReferenceRewriter(memories, "portable", workspaceId),
          });
          if (!safeSessionMerge) conflicts.push(item.path);
        }
        continue;
      }
      const current = await optionalFile(item.path);
      const appliedKeyEpoch = config.applied[item.mapping.namespace]?.keyEpoch ?? 1;
      const keys = await this.#scopeKeys(item.mapping.namespace, appliedKeyEpoch);
      const currentDigest = current === undefined ? undefined : await computeObjectId(keys.dedupKey, current);
      if (currentDigest !== guard.digest) throw new SyncConflict([item.path]);
      if (!current || bytesEqual(current, item.bytes)) continue;
      const prior = config.applied[item.mapping.namespace]?.digests[item.logicalPath];
      const safeSessionMerge = item.mapping.kind !== "drop" && portableSession(item.logicalPath) !== undefined && isCompleteJsonlRecordSupersequence(current, item.bytes);
      if (currentDigest !== prior && !safeSessionMerge && !(item.mapping.id.startsWith("workspace_") && !prior && await cleanGitDestination(item.mapping.path, item.path))) {
        conflicts.push(item.path);
      }
    }
    for (const item of deletions) {
      const currentDigest = (await guardFile(item)).digest;
      if (!currentDigest) continue;
      const prior = config.applied[item.mapping.namespace]?.digests[item.logicalPath];
      if (!prior || currentDigest !== prior) conflicts.push(item.path);
    }
    if (conflicts.length > 0 && !options.allowLocalOverwrite) throw new SyncConflict(conflicts);
    const workspaceFiles = readyWorkspaces.reduce((total, item) => total + item.captured.capsule.records.length, 0);
    const fileCount = materialized.length + deletions.length + workspaceFiles + settingsPlan.writes.length + instructionPlan.writes.length + instructionPlan.deletes.length + memoryPlan.writes.length + memoryPlan.deletes.length;
    if (dryRun) return { outcome: "pulled", revisionId: remoteRevisionId, files: fileCount, objects: objectCount, bytes: byteCount };

    await settingsPlan.guard();
    await instructionPlan.guard();
    await memoryPlan.guard();

    // Build the complete applied/binding proposal before publishing any file.
    // Keep previous marker objects intact so a failed durable decision can
    // restore the caller's in-memory view as well as the on-disk checkpoint.
    const profile = this.#materializationOwners.get(config) ?? config;
    const proposed: LocalConfig = { ...profile, applied: { ...profile.applied }, sessionBindings: { ...profile.sessionBindings } };
    for (const mapping of selected) {
      if (incompleteNamespaces.has(mapping.namespace)) continue;
      const digests: Record<string, string> = {};
      for (const item of materialized.filter((candidate) => candidate.mapping.namespace === mapping.namespace)) digests[item.logicalPath] = item.digest;
      for (const item of settingsPlan.digests.filter((candidate) => candidate.namespace === mapping.namespace)) digests[item.logicalPath] = item.digest;
      for (const item of instructionPlan.digests.filter((candidate) => candidate.namespace === mapping.namespace)) digests[item.logicalPath] = item.digest;
      for (const item of memoryPlan.digests.filter((candidate) => candidate.namespace === mapping.namespace)) digests[item.logicalPath] = item.digest;
      proposed.applied[mapping.namespace] = { revisionId: appliedRevision(mapping.namespace), digests, keyEpoch: appliedKeyEpoch(mapping.namespace) };
    }
    recordMaterializedSessionBindings(proposed, materialized, deletions);
    const guardedFiles = <T extends FileTransaction>(transaction: T): T => ({
      ...transaction,
      beforeCommit: async (index, path) => {
        await transaction.beforeCommit?.(index, path);
        await settingsPlan!.guard(path);
        await instructionPlan!.guard(path);
        await memoryPlan!.guard(path);
        try { await fileGuards.get(resolve(path))?.assertUnchanged(); }
        catch { throw new SyncConflict([path]); }
      },
    });

    if (options.replaceWorkspaces) {
      if (!options.prepareWorkspaceRecovery) throw new Error("workspace replacement requires persistent recovery preparation");
      const workspace = readyWorkspaces[0];
      if (workspace) {
        await replaceWorkspaceCapsule(workspace.mapping.path, workspace.captured, {
          gitFetch: workspace.gitFetch,
          materialize: options.materialize ?? applyFileTransaction,
          beforeMutation: options.prepareWorkspaceRecovery,
        });
      }
    } else {
      const workspaces = readyWorkspaces.map((workspace) => ({ root: workspace.mapping.path, captured: workspace.captured, gitFetch: workspace.gitFetch, expectedCurrent: workspace.expectedCurrent }));
      const files: WorkspaceFileTransaction = {
        writes: [...materialized.map(materializedWrite), ...settingsPlan.writes, ...instructionPlan.writes, ...memoryPlan.writes],
        deletes: [...deletions.map((item) => item.path), ...instructionPlan.deletes, ...memoryPlan.deletes],
      };
      // Explicit historical restore retains its emergency/publication lifecycle;
      // it must not accidentally commit a temporary working profile here.
      if (this.options.commitMaterialization && !options.materialize) {
        const originalApplied = profile.applied, originalBindings = profile.sessionBindings;
        profile.applied = proposed.applied; profile.sessionBindings = proposed.sessionBindings;
        try { await this.options.commitMaterialization(profile, workspaces, guardedFiles(files)); }
        catch (error) {
          profile.applied = originalApplied;
          if (originalBindings === undefined) delete profile.sessionBindings; else profile.sessionBindings = originalBindings;
          throw error;
        }
      } else await applyWorkspaceTransaction(workspaces, files,
        { materialize: async transaction => (options.materialize ?? applyFileTransaction)(guardedFiles(transaction)) });
    }
    config.applied = proposed.applied; config.sessionBindings = proposed.sessionBindings;
    return { outcome: "pulled", revisionId: remoteRevisionId, files: fileCount, objects: objectCount, bytes: byteCount };
    } finally {
      settingsPlan?.dispose();
      instructionPlan?.dispose();
      memoryPlan?.dispose();
      for (const item of incomingInstructions) item.bytes?.fill(0);
      for (const item of incomingMemory) item.bytes?.fill(0);
      await Promise.all(stagedDisposers.map((dispose) => dispose()));
    }
  }

  async #verifiedAppliedWorkspace(config: LocalConfig, mapping: RootMapping): Promise<CapturedWorkspace | undefined> {
    const applied = config.applied[mapping.namespace];
    if (!applied) return undefined;
    // Resolve the exact authenticated prior namespace, not the latest head or
    // an unverified local digest map. Missing history is never overwrite consent.
    const pointer = await this.client.namespaceRevision(this.vaultId, mapping.namespace, applied.revisionId);
    if (pointer.namespace !== mapping.namespace || pointer.revisionId !== applied.revisionId) {
      throw new Error("applied workspace revision pointer does not match its request");
    }
    const { manifest } = await this.#resolveNamespaceManifest(pointer);
    const current = await captureWorkspace(mapping.path, { gitFetch: "never" });
    const scanned = capturedWorkspaceEntries(mapping, current);
    if (scanned.length !== manifest.entries.length) return undefined;
    const entries = new Map(manifest.entries.map((entry) => [entry.logicalPath, entry]));
    const epochKeys = new Map<number, { encryptionKey: Uint8Array; dedupKey: Uint8Array }>();
    try {
      for (const file of scanned) {
        const prior = entries.get(file.logicalPath);
        if (!prior || prior.entryType !== file.entryType || prior.workspacePath !== file.workspacePath ||
            prior.workspaceLayer !== file.workspaceLayer || prior.fileMode !== file.fileMode) return undefined;
        const epoch = prior.keyEpoch ?? 1;
        let keys = epochKeys.get(epoch);
        if (!keys) { keys = await this.#scopeKeys(mapping.namespace, epoch); epochKeys.set(epoch, keys); }
        if (await computeScannedDigest(keys.dedupKey, file) !== prior.contentDigest) return undefined;
      }
      return current;
    } finally {
      for (const keys of epochKeys.values()) { keys.encryptionKey.fill(0); keys.dedupKey.fill(0); }
    }
  }

  async #pullScoped(config: LocalConfig, dryRun: boolean, historicalRevisionId?: string): Promise<SyncResult> {
    if (this.scopedAccess && this.scopedAccess.expiresAt <= Date.now()) throw new Error("scoped capability has expired");
    const remote = historicalRevisionId
      ? await this.client.scopedRevision(this.vaultId, historicalRevisionId)
      : await this.client.namespaceHeads(this.vaultId);
    const allowed = this.scopedAccess ? new Set(Object.keys(this.scopedAccess.namespaceKeys)) : undefined;
    const configured = [...syncRootMappings(config).filter((mapping) => mapping.mode !== "publish"), ...workspaceMappings(config)];
    const unauthorized = allowed ? configured.filter((mapping) => !allowed.has(mapping.namespace)) : [];
    if (unauthorized.length > 0) {
      throw new Error(`capability does not authorize configured namespaces: ${unauthorized.map((mapping) => mapping.namespace).sort().join(", ")}`);
    }
    const selected = allowed ? configured.filter((mapping) => allowed.has(mapping.namespace)) : configured;
    const heads = new Map(remote.namespaces.map((head) => [head.namespace, head]));
    if (!selected.some((mapping) => heads.has(mapping.namespace))) return { outcome: "unchanged", revisionId: remote.revisionId, files: 0, objects: 0, bytes: 0 };
    const missingHeads = selected.filter((mapping) => !heads.has(mapping.namespace));
    if (missingHeads.length > 0) {
      throw new Error(`namespace heads are missing for configured mappings: ${missingHeads.map((mapping) => mapping.namespace).sort().join(", ")}`);
    }
    // Validate the complete configured scope above, but do not inspect or rewrite
    // a local namespace just because an independent remote namespace advanced.
    // Explicit hydration clears its selected applied markers and still hydrates
    // the complete pinned closure through this same path.
    const advanced = selected.filter((mapping) => config.applied[mapping.namespace]?.revisionId !== heads.get(mapping.namespace)!.revisionId);
    if (advanced.length === 0) return { outcome: "unchanged", revisionId: remote.revisionId, files: 0, objects: 0, bytes: 0 };
    const relevantHeads = advanced.map((mapping) => heads.get(mapping.namespace)!);

    const manifests: NamespaceManifestV1[] = [];
    let manifestObjectCount = 0;
    for (const head of relevantHeads) {
      const resolved = await this.#resolveNamespaceManifest(head);
      manifests.push(resolved.manifest);
      manifestObjectCount += resolved.manifestObjects;
    }
    const revisionId = remote.revisionId ?? manifests.map((manifest) => manifest.namespaceRevisionId).sort().join(":");
    const combined: VaultManifestV1 = {
      schemaVersion: 1,
      vaultId: this.vaultId,
      revisionId,
      parentRevisionIds: [],
      createdAt: manifests.map((manifest) => manifest.createdAt).sort().at(-1)!,
      createdByDeviceId: "scoped_remote",
      operationId: "scoped_pull",
      entries: manifests.flatMap((manifest) => manifest.entries),
      tombstones: manifests.flatMap((manifest) => manifest.tombstones),
      conflicts: manifests.flatMap((manifest) => manifest.conflicts),
      sessionCapsules: manifests.flatMap((manifest) => manifest.sessionCapsules ?? []),
    };
    return this.#materializeManifest(config, dryRun, revisionId, combined, advanced, manifestObjectCount,
      (namespace, objectId) => this.client.getNamespaceObject(this.vaultId, namespace, objectId),
      (namespace) => heads.get(namespace)!.revisionId,
      (namespace) => heads.get(namespace)!.keyEpoch ?? 1);
  }

  async #downloadScopedVaultManifest(
    historicalRevisionId?: string,
    knownPointer?: { revisionId: string | null; namespaces: Array<{ namespace: string; revisionId: string; manifestObjectId: string }> },
  ): Promise<VaultManifestV1 | undefined> {
    const pointer = knownPointer ?? (historicalRevisionId
      ? await this.client.scopedRevision(this.vaultId, historicalRevisionId)
      : await this.client.namespaceHeads(this.vaultId));
    if (pointer.namespaces.length === 0) return undefined;
    const manifests = await Promise.all(pointer.namespaces.map((head) => this.#resolveNamespaceManifest(head).then((result) => result.manifest)));
    const revisionId = pointer.revisionId ?? manifests.map((manifest) => manifest.namespaceRevisionId).sort().join(":");
    return {
      schemaVersion: 1,
      vaultId: this.vaultId,
      revisionId,
      parentRevisionIds: [],
      createdAt: manifests.map((manifest) => manifest.createdAt).sort().at(-1)!,
      createdByDeviceId: "scoped_remote",
      operationId: "scoped_read",
      entries: manifests.flatMap((manifest) => manifest.entries),
      tombstones: manifests.flatMap((manifest) => manifest.tombstones),
      conflicts: manifests.flatMap((manifest) => manifest.conflicts),
      sessionCapsules: manifests.flatMap((manifest) => manifest.sessionCapsules ?? []),
    };
  }

  async #resolveNamespaceManifest(head: RemoteNamespaceHead): Promise<{ manifest: NamespaceManifestV1; manifestObjects: number }> {
    const chain: NamespaceManifestV1[] = [];
    const seen = new Set<string>();
    let pointer: RemoteNamespaceHead & { previousRevisionId?: string | null } = head;
    for (let depth = 0; depth < 256; depth += 1) {
      if (seen.has(pointer.revisionId)) throw new Error("namespace manifest chain contains a cycle");
      seen.add(pointer.revisionId);
      const pointerKeyEpoch = pointer.keyEpoch ?? 1;
      const keys = await this.#scopeKeys(pointer.namespace, pointerKeyEpoch);
      const envelope = await this.client.getNamespaceObject(this.vaultId, pointer.namespace, pointer.manifestObjectId);
      const plaintext = await decryptEnvelope({
        envelope,
        key: keys.encryptionKey,
        dedupKey: keys.dedupKey,
        expected: { vaultId: this.vaultId, scopeId: pointer.namespace, compression: "none" },
      });
      const parsedManifest = namespaceManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(plaintext)));
      if ((parsedManifest.keyEpoch ?? 1) !== pointerKeyEpoch) throw new Error("namespace key epoch does not match its pointer");
      const manifest: NamespaceManifestV1 = {
        ...parsedManifest,
        keyEpoch: pointerKeyEpoch,
        entries: parsedManifest.entries.map((entry) => ({ ...entry, keyEpoch: entry.keyEpoch ?? pointerKeyEpoch })),
      };
      if (manifest.vaultId !== this.vaultId || manifest.namespace !== pointer.namespace || manifest.namespaceRevisionId !== pointer.revisionId) {
        throw new Error("namespace revision and encrypted manifest do not match");
      }
      if (pointer.commitMode !== "replace" && [...manifest.entries, ...manifest.tombstones].some((entry) => isInstructionAuthorityPath(pointer.namespace, entry.logicalPath))) {
        throw new InstructionError("INSTRUCTION_AUTHORITY_UNVERIFIED");
      }
      if (pointer.commitMode === "append") {
        // The encrypted manifest is controlled by the scope-key holder. Its
        // claimed mode/parent must agree with immutable server provenance.
        const revision: RemoteNamespaceRevision = pointer.previousRevisionId === undefined
          ? await this.client.namespaceRevision(this.vaultId, pointer.namespace, pointer.revisionId)
          : pointer as RemoteNamespaceRevision;
        if (revision.namespace !== pointer.namespace || revision.revisionId !== pointer.revisionId ||
            revision.manifestObjectId !== pointer.manifestObjectId || (revision.keyEpoch ?? 1) !== pointerKeyEpoch || revision.commitMode !== "append") {
          throw new Error("namespace commit provenance does not match its pointer");
        }
        if (revision.previousRevisionId === null
          ? manifest.mode !== "snapshot" || manifest.parentNamespaceRevisionIds.length !== 0
          : manifest.mode !== "delta" || manifest.parentNamespaceRevisionIds.length !== 1 || manifest.parentNamespaceRevisionIds[0] !== revision.previousRevisionId) {
          throw new Error("append manifest does not preserve its authorized predecessor");
        }
      }
      await this.#assertNamespacePathClaims(manifest, keys.dedupKey);
      chain.push(manifest);
      if (manifest.mode === "snapshot") break;
      if (manifest.parentNamespaceRevisionIds.length !== 1) throw new Error("delta namespace manifest must have exactly one parent");
      const parentId = manifest.parentNamespaceRevisionIds[0]!;
      const parent = await this.client.namespaceRevision(this.vaultId, pointer.namespace, parentId);
      if (parent.namespace !== pointer.namespace || parent.revisionId !== parentId) throw new Error("namespace revision pointer does not match its request");
      pointer = parent;
      if (depth === 255) throw new Error("namespace manifest chain exceeds the safety limit");
    }
    const ordered = chain.reverse();
    if (ordered[0]?.mode !== "snapshot") throw new Error("namespace manifest chain has no snapshot base");
    const entries = new Map<string, NamespaceManifestV1["entries"][number]>();
    const tombstones = new Map<string, NamespaceManifestV1["tombstones"][number]>();
    const capsules = new Map<string, SessionCapsuleV1>();
    for (const manifest of ordered) {
      if (manifest.mode === "snapshot") {
        entries.clear();
        tombstones.clear();
        capsules.clear();
      }
      for (const entry of manifest.entries) {
        entries.set(entry.logicalPath, entry);
        tombstones.delete(entry.logicalPath);
      }
      for (const tombstone of manifest.tombstones) {
        entries.delete(tombstone.logicalPath);
        tombstones.set(tombstone.logicalPath, tombstone);
      }
      for (const capsule of manifest.sessionCapsules ?? []) capsules.set(capsule.sessionKey, capsule);
    }
    const latest = ordered.at(-1)!;
    return {
      manifest: {
        ...latest,
        mode: "snapshot",
        entries: [...entries.values()].sort(compareEntries),
        tombstones: [...tombstones.values()].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, "en")),
        sessionCapsules: [...capsules.values()].sort((left, right) => left.sessionKey.localeCompare(right.sessionKey, "en")),
        pathClaims: [],
      },
      manifestObjects: chain.length,
    };
  }

  async #assertNamespacePathClaims(manifest: NamespaceManifestV1, dedupKey: Uint8Array): Promise<void> {
    type Mutation = "add" | "update" | "delete";
    const expected = new Map<string, { logicalPath: string; mutations: ReadonlySet<Mutation> }>();
    const addCandidate = (pathId: string, logicalPath: string, mutations: ReadonlySet<Mutation>): void => {
      if (expected.has(pathId)) throw new Error("namespace manifest contains colliding path claims");
      expected.set(pathId, { logicalPath, mutations });
    };
    const addExpected = async (logicalPath: string, mutations: ReadonlySet<Mutation>): Promise<void> => {
      const claimInput = manifest.mode === "delta" ? `${manifest.operationId}\0${logicalPath}` : logicalPath;
      addCandidate(await computePathId(dedupKey, claimInput), logicalPath, mutations);
      if (manifest.mode === "snapshot") {
        addCandidate(await computePathId(dedupKey, `${manifest.operationId}\0${logicalPath}`), logicalPath, new Set(["add"]));
      }
    };
    for (const entry of manifest.entries) await addExpected(entry.logicalPath, new Set(["add", "update"]));
    for (const tombstone of manifest.tombstones) {
      await addExpected(tombstone.logicalPath, new Set(manifest.mode === "delta" ? ["add"] : ["delete"]));
    }
    if (manifest.pathClaims.length !== manifest.entries.length + manifest.tombstones.length) {
      throw new Error("namespace manifest path claims do not cover its content");
    }
    const coveredPaths = new Set<string>();
    for (const claim of manifest.pathClaims) {
      const candidate = expected.get(claim.pathId);
      if (!candidate?.mutations.has(claim.mutation) || coveredPaths.has(candidate.logicalPath)) {
        throw new Error(`namespace manifest path claim does not match its content (${manifest.namespaceRevisionId}:${claim.mutation})`);
      }
      coveredPaths.add(candidate.logicalPath);
    }
    if (coveredPaths.size !== manifest.entries.length + manifest.tombstones.length) throw new Error("namespace manifest path claims do not cover its content");
  }

  async #mergeStagedSessionAppend(
    baseEntry: NamespaceManifestV1["entries"][number],
    remoteEntry: NamespaceManifestV1["entries"][number],
    local: ScannedEntry,
    keys: { encryptionKey: Uint8Array; dedupKey: Uint8Array },
    config: LocalConfig,
  ): Promise<{
    path: string;
    size: number;
    objectIds: string[];
    contentDigest: string;
    activity: ActivityReference[];
    dispose(): Promise<void>;
  } | undefined> {
    if (!local.stagedPath) throw new Error("streaming append merge requires a staged local session");
    if (!local.session) throw new Error("streaming append merge requires session metadata");
    const workspace = config.workspaces.find((candidate) => candidate.id === local.session!.workspaceId);
    if (!workspace) throw new Error(`workspace ${local.session.workspaceId} is not mapped on this device`);
    const downloaded: Array<Awaited<ReturnType<typeof downloadVerifiedEntry>>> = [];
    const ownedKeys: Uint8Array[] = [];
    let disposeMerged: (() => Promise<void>) | undefined;
    try {
      const baseKeys = await this.#scopeKeys(baseEntry.namespace, baseEntry.keyEpoch ?? 1);
      ownedKeys.push(baseKeys.encryptionKey, baseKeys.dedupKey);
      const base = await downloadVerifiedEntry({
        objectIds: baseEntry.objectIds,
        totalSize: baseEntry.totalSize,
        contentDigest: baseEntry.contentDigest,
        maximumSize: MAX_STREAMED_SESSION_BYTES,
        keys: baseKeys,
        vaultId: this.vaultId,
        namespace: baseEntry.namespace,
        getObject: (objectId) => this.client.getNamespaceObject(this.vaultId, baseEntry.namespace, objectId),
      });
      downloaded.push(base);
      const remoteKeys = await this.#scopeKeys(remoteEntry.namespace, remoteEntry.keyEpoch ?? 1);
      ownedKeys.push(remoteKeys.encryptionKey, remoteKeys.dedupKey);
      const remote = await downloadVerifiedEntry({
        objectIds: remoteEntry.objectIds,
        totalSize: remoteEntry.totalSize,
        contentDigest: remoteEntry.contentDigest,
        maximumSize: MAX_STREAMED_SESSION_BYTES,
        keys: remoteKeys,
        vaultId: this.vaultId,
        namespace: remoteEntry.namespace,
        getObject: (objectId) => this.client.getNamespaceObject(this.vaultId, remoteEntry.namespace, objectId),
      });
      downloaded.push(remote);
      const merged = await mergeJsonlAppendFiles({
        basePath: base.path,
        remotePath: remote.path,
        localPath: local.stagedPath,
      });
      if (merged.outcome === "merged") disposeMerged = merged.dispose;
      // Finish input cleanup before transferring ownership of the merged stage.
      // allSettled waits for every input even when one cleanup fails.
      const cleanup = await Promise.allSettled(downloaded.map((item) => item.dispose()));
      downloaded.length = 0;
      const failed = cleanup.find((item) => item.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      if (merged.outcome === "diverged") return undefined;
      const described = await describeStagedJsonl(merged.path, keys.dedupKey, JSONL_CHUNK_POLICY);
      const activity = await inspectPortableSessionActivity(merged.path, workspace.id, resolve(workspace.path),
        { memories: sessionMemoryRoots(memoryMappings(config), local.namespace) });
      return { ...merged, ...described, activity };
    } catch (error) {
      await Promise.allSettled([
        ...downloaded.map((item) => item.dispose()),
        ...(disposeMerged ? [disposeMerged()] : []),
      ]);
      throw error;
    } finally {
      for (const key of ownedKeys) key.fill(0);
    }
  }

  async #entryAtCurrentDigest(entry: NamespaceManifestV1["entries"][number]): Promise<NamespaceManifestV1["entries"][number]> {
    if ((entry.keyEpoch ?? 1) === this.keyEpoch) return entry;
    const oldKeys = await this.#scopeKeys(entry.namespace, entry.keyEpoch ?? 1);
    const ownedKeys = Object.values(oldKeys);
    try {
      const keys = await this.#scopeKeys(entry.namespace);
      ownedKeys.push(keys.encryptionKey, keys.dedupKey);
      const staged = await downloadVerifiedEntry({
        ...entry,
        maximumSize: entry.chunking?.strategy === "jsonl-records" ? MAX_STREAMED_SESSION_BYTES : MAX_FILE_BYTES,
        keys: oldKeys,
        vaultId: this.vaultId,
        getObject: (objectId) => this.client.getNamespaceObject(this.vaultId, entry.namespace, objectId),
      });
      try {
        return { ...entry, contentDigest: await computeObjectIdStream(keys.dedupKey, createReadStream(staged.path)) };
      } finally {
        await staged.dispose();
      }
    } finally {
      for (const key of ownedKeys) key.fill(0);
    }
  }

  async #rekeyEntry(entry: NamespaceManifestV1["entries"][number], dryRun = false): Promise<NamespaceManifestV1["entries"][number]> {
    if ((entry.keyEpoch ?? 1) === this.keyEpoch) return entry;
    const oldKeys = await this.#scopeKeys(entry.namespace, entry.keyEpoch ?? 1);
    const ownedKeys = Object.values(oldKeys);
    try {
      const keys = await this.#scopeKeys(entry.namespace);
      ownedKeys.push(keys.encryptionKey, keys.dedupKey);
      const streamed = entry.chunking?.strategy === "jsonl-records";
      const staged = await downloadVerifiedEntry({
        ...entry,
        maximumSize: streamed ? MAX_STREAMED_SESSION_BYTES : MAX_FILE_BYTES,
        keys: oldKeys,
        vaultId: this.vaultId,
        getObject: (objectId) => this.client.getNamespaceObject(this.vaultId, entry.namespace, objectId),
      });
      try {
        const objectIds: string[] = [];
        const source = createReadStream(staged.path, { highWaterMark: JSONL_CHUNK_POLICY.maxSize });
        const chunks = streamed ? chunkJsonlStream(source, JSONL_CHUNK_POLICY) : source;
        for await (const plaintext of chunks) {
          const objectId = await computeObjectId(keys.dedupKey, plaintext);
          const envelope = await encryptEnvelope({
            plaintext,
            key: keys.encryptionKey,
            dedupKey: keys.dedupKey,
            context: { vaultId: this.vaultId, scopeId: entry.namespace, compression: "none" },
          });
          if (!dryRun) await this.client.putNamespaceObject(this.vaultId, entry.namespace, objectId, envelope);
          objectIds.push(objectId);
        }
        return {
          ...entry,
          keyEpoch: this.keyEpoch,
          objectIds,
          contentDigest: await computeObjectIdStream(keys.dedupKey, createReadStream(staged.path)),
          chunking: streamed
            ? { strategy: "jsonl-records", ...JSONL_CHUNK_POLICY }
            : { strategy: "fixed", size: JSONL_CHUNK_POLICY.maxSize },
        };
      } finally {
        await staged.dispose();
      }
    } finally {
      for (const key of ownedKeys) key.fill(0);
    }
  }

  async #downloadManifest(objectId: string): Promise<VaultManifestV1> {
    const envelope = await this.client.getObject(this.vaultId, objectId);
    const keys = await this.#scopeKeys("manifest", 1);
    const plaintext = await decryptEnvelope({
      envelope,
      key: keys.encryptionKey,
      dedupKey: keys.dedupKey,
      expected: { vaultId: this.vaultId, scopeId: "manifest", compression: "none" },
    });
    return manifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(plaintext)));
  }

  async #publishNamespaceMirrors(
    manifest: VaultManifestV1,
    namespaces: ReadonlySet<string>,
    knownEnvelopes?: ReadonlyMap<string, Uint8Array>,
  ): Promise<string | null> {
    const remote = await this.client.namespaceHeads(this.vaultId);
    const heads = new Map(remote.namespaces.map((head) => [head.namespace, head]));
    const updates = [];
    for (const namespace of [...namespaces].sort((left, right) => left.localeCompare(right, "en"))) {
      const current = heads.get(namespace);
      if (current) continue;
      const keys = await this.#scopeKeys(namespace);
      const entries = manifest.entries
        .filter((entry) => entry.namespace === namespace)
        .map((entry) => ({ ...entry, keyEpoch: entry.keyEpoch ?? this.keyEpoch }));
      const tombstones = manifest.tombstones.filter((entry) => entry.namespace === namespace);
      const conflicts = manifest.conflicts.filter((entry) => entry.namespace === namespace);
      const claims = [];
      const claimed = new Set<string>();
      for (const entry of entries) {
        const pathId = await computePathId(keys.dedupKey, entry.logicalPath);
        if (!claimed.has(pathId)) claims.push({ pathId, mutation: "add" as const });
        claimed.add(pathId);
      }
      for (const tombstone of tombstones) {
        const pathId = await computePathId(keys.dedupKey, tombstone.logicalPath);
        if (!claimed.has(pathId)) claims.push({ pathId, mutation: "delete" as const });
        claimed.add(pathId);
      }
      const namespaceRevisionId = randomId("nrev");
      const namespaceManifest: NamespaceManifestV1 = namespaceManifestSchema.parse({
        schemaVersion: 1,
        vaultId: this.vaultId,
        namespace,
        keyEpoch: this.keyEpoch,
        namespaceRevisionId,
        parentNamespaceRevisionIds: [],
        createdAt: manifest.createdAt,
        createdByDeviceId: manifest.createdByDeviceId,
        operationId: manifest.operationId,
        mode: "snapshot",
        entries,
        tombstones,
        conflicts,
        sessionCapsules: (manifest.sessionCapsules ?? []).filter((capsule) => capsule.harness.namespace === namespace),
        pathClaims: claims,
      });
      const requiredObjectIds = [...new Set([
        ...entries.flatMap((entry) => entry.objectIds),
        ...conflicts.flatMap((conflict) => conflict.variantObjectIds),
      ])];
      for (const objectId of requiredObjectIds) {
        const envelope = knownEnvelopes?.get(objectId) ?? await this.client.getObject(this.vaultId, objectId);
        await this.client.putNamespaceObject(this.vaultId, namespace, objectId, envelope);
      }
      const bytes = encoder.encode(canonicalJson(namespaceManifest));
      const manifestObjectId = await computeObjectId(keys.dedupKey, bytes);
      const envelope = await encryptEnvelope({
        plaintext: bytes,
        key: keys.encryptionKey,
        dedupKey: keys.dedupKey,
        context: { vaultId: this.vaultId, scopeId: namespace, compression: "none" },
      });
      await this.client.putNamespaceObject(this.vaultId, namespace, manifestObjectId, envelope);
      updates.push({
        namespace,
        keyEpoch: this.keyEpoch,
        baseNamespaceRevisionId: null,
        namespaceRevisionId,
        manifestObjectId,
        requiredObjectIds,
        ...(namespaceManifest.sessionCapsules?.length
          ? { retainedVaultRevisionIds: capsuleRetentionRoots(namespaceManifest.sessionCapsules) }
          : {}),
        mode: "replace" as const,
        pathClaims: claims,
      });
    }
    if (updates.length === 0) return remote.revisionId;
    const committed = await this.client.commitNamespaces(this.vaultId, {
      protocolVersion: "1.1",
      operationId: randomId("op"),
      vaultRevisionId: randomId("srev"),
      updates,
    });
    return committed.revisionId;
  }

  async #markApplied(config: LocalConfig, mappings: RootMapping[], scanned: ScannedEntry[], revisionId: string): Promise<void> {
    for (const mapping of mappings) {
      const keys = await this.#scopeKeys(mapping.namespace);
      const digests: Record<string, string> = {};
      for (const file of scanned.filter((candidate) => candidate.namespace === mapping.namespace)) {
        digests[file.logicalPath] = await computeNativeSnapshotDigest(keys.dedupKey, file);
      }
      config.applied[mapping.namespace] = { revisionId, digests, keyEpoch: this.keyEpoch };
    }
  }

  async #markNamespaceRevisions(config: LocalConfig, mappings: RootMapping[]): Promise<void> {
    if (mappings.length === 0) return;
    const heads = new Map((await this.client.namespaceHeads(this.vaultId)).namespaces.map((head) => [head.namespace, head]));
    for (const mapping of mappings) {
      const head = heads.get(mapping.namespace);
      if (head && config.applied[mapping.namespace]) {
        config.applied[mapping.namespace]!.revisionId = head.revisionId;
        config.applied[mapping.namespace]!.keyEpoch = head.keyEpoch ?? 1;
      }
    }
  }

  async #scopeKeys(scope: string, keyEpoch = this.keyEpoch): Promise<{ encryptionKey: Uint8Array; dedupKey: Uint8Array }> {
    if (this.vaultKeyring) {
      const vaultKey = this.vaultKeyring.keys[keyEpoch];
      if (!vaultKey) throw new Error(`vault key epoch ${keyEpoch} is unavailable on this device`);
      return deriveScopeKey(vaultKey, scope);
    }
    if (keyEpoch !== this.keyEpoch) throw new Error(`capability does not authorize key epoch ${keyEpoch}`);
    const encoded = this.scopedAccess?.namespaceKeys[scope];
    if (!encoded) throw new Error(`capability does not authorize namespace ${scope}`);
    const encryptionKey = Buffer.from(encoded.encryptionKey, "base64url");
    const dedupKey = Buffer.from(encoded.dedupKey, "base64url");
    if (encryptionKey.byteLength !== 32 || dedupKey.byteLength !== 32) throw new Error("stored namespace key is invalid");
    return { encryptionKey, dedupKey };
  }
}

async function computePathId(dedupKey: Uint8Array, logicalPath: string): Promise<string> {
  return computeObjectId(dedupKey, encoder.encode(`statecase:path:v1\0${logicalPath}`));
}

async function buildSessionCapsules(input: {
  vaultId: string;
  revisionId: string;
  createdAt: string;
  createdByDeviceId: string;
  config: LocalConfig;
  scanned: ScannedEntry[];
  entries: VaultManifestV1["entries"];
  previous?: VaultManifestV1;
}): Promise<SessionCapsuleV1[]> {
  const scannedSessions = input.scanned.filter((entry) => entry.session?.workspaceId);
  const configuredMemories = memoryMappings(input.config);
  const writableHarnessNamespaces = new Set(input.config.mappings
    .filter((mapping) => mapping.kind !== "drop" && mapping.mode !== "consume")
    .map((mapping) => mapping.namespace));
  const liveSessionIdentities = new Set(scannedSessions.map((entry) => `${entry.namespace}\0${entry.logicalPath}`));
  const capsules = (input.previous?.sessionCapsules ?? []).filter((capsule) =>
    !writableHarnessNamespaces.has(capsule.harness.namespace) ||
    liveSessionIdentities.has(`${capsule.harness.namespace}\0${capsule.harness.logicalPath}`));

  for (const scanned of scannedSessions) {
    const session = scanned.session!;
    const workspaceId = session.workspaceId!;
    const profile = scanned.namespace.split(":").slice(2).join(":") || "default";
    const harness = scanned.namespace.split(":")[1] ?? "unknown";
    const sessionKey = `${input.vaultId}:${harness}:${profile}:${workspaceId}:${session.nativeSessionId}`;
    const priorCapsuleIndex = capsules.findIndex((capsule) => capsule.sessionKey === sessionKey);
    const priorEntry = input.previous?.entries.find((entry) => entry.namespace === scanned.namespace && entry.logicalPath === scanned.logicalPath);
    const currentEntry = input.entries.find((entry) => entry.namespace === scanned.namespace && entry.logicalPath === scanned.logicalPath);
    const selectedMemories = configuredMemories.filter((mapping) =>
      mapping.memory!.harnessNamespace === scanned.namespace &&
      (mapping.memory!.kind === "codex-global" || mapping.memory!.workspaceId === workspaceId));
    const memoryIds = selectedMemories.map((mapping) => mapping.namespace.slice("memory:".length)).sort();
    const priorMemoryIds = (capsules[priorCapsuleIndex]?.memories ?? []).map((pin) => pin.memoryId).sort();
    if (priorCapsuleIndex >= 0 && priorEntry?.contentDigest === currentEntry?.contentDigest &&
        canonicalJson(memoryIds) === canonicalJson(priorMemoryIds)) continue;
    for (const mapping of selectedMemories) {
      if (!input.entries.some((entry) => entry.namespace === mapping.namespace && entry.logicalPath === MEMORY_DESCRIPTOR_PATH)) throw new MemoryIdentityError();
    }

    const workspace = input.config.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) continue;
    const captured = workspaceCaptureFromScan(input.scanned, workspaceId);
    const dependencies = await resolveActivityDependencies(session.activity, workspaceId, input.config, input.entries, input.scanned, captured, selectedMemories);
    const drops = [...new Set(dependencies
      .filter((dependency) => dependency.source === "drop")
      .map((dependency) => dependency.logicalPath.split("/")[0]!))]
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((dropId) => ({ dropId, revisionId: input.revisionId }));
    const capsule: SessionCapsuleV1 = {
      sessionCapsuleId: randomId("cap"),
      sessionKey,
      harnessRevisionId: input.revisionId,
      harness: { namespace: scanned.namespace, logicalPath: scanned.logicalPath },
      workspace: {
        workspaceId,
        capsuleRevisionId: input.revisionId,
        ...(captured?.capsule.baseCommit ? { baseCommit: captured.capsule.baseCommit } : {}),
      },
      drops,
      ...(memoryIds.length ? { memories: memoryIds.map((memoryId) => ({ memoryId, revisionId: input.revisionId })) } : {}),
      dependencies,
      createdAt: input.createdAt,
      createdByDeviceId: input.createdByDeviceId,
    };
    if (priorCapsuleIndex >= 0) capsules.splice(priorCapsuleIndex, 1, capsule);
    else capsules.push(capsule);
  }
  return capsules.sort((left, right) => left.sessionKey.localeCompare(right.sessionKey, "en"));
}

function capsuleRetentionRoots(capsules: readonly SessionCapsuleV1[]): string[] {
  return [...new Set(capsules.flatMap((capsule) => [
    capsule.harnessRevisionId,
    capsule.workspace.capsuleRevisionId,
    ...capsule.drops.map((drop) => drop.revisionId),
    ...(capsule.memories ?? []).map((memory) => memory.revisionId),
  ]))].sort((left, right) => left.localeCompare(right, "en"));
}

function workspaceCaptureFromScan(scanned: readonly ScannedEntry[], workspaceId: string): CapturedWorkspace | undefined {
  const entry = scanned.find((candidate) =>
    candidate.namespace === `workspace:${workspaceId}` && candidate.entryType === "workspace-capsule");
  if (!entry) return undefined;
  return {
    capsule: JSON.parse(new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(entry.bytes)) as CapturedWorkspace["capsule"],
    blobs: [],
  };
}

async function resolveActivityDependencies(
  activity: readonly ActivityReference[],
  sessionWorkspaceId: string,
  config: LocalConfig,
  entries: VaultManifestV1["entries"],
  scanned: readonly ScannedEntry[],
  captured: CapturedWorkspace | undefined,
  memories: readonly RootMapping[],
): Promise<DependencyReference[]> {
  const output: DependencyReference[] = [];
  const seen = new Set<string>();
  const roots = [
    ...config.workspaces.filter((workspace) => workspace.id === sessionWorkspaceId)
      .map((workspace) => ({ kind: "workspace" as const, id: workspace.id, root: resolve(workspace.path) })),
    ...config.mappings.filter((mapping) => mapping.kind === "drop").map((mapping) => ({ kind: "drop" as const, id: mapping.id, root: resolve(mapping.path), namespace: mapping.namespace })),
    ...memories.map((mapping) => ({ kind: "memory" as const, id: mapping.namespace.slice("memory:".length), root: resolve(mapping.path), namespace: mapping.namespace })),
  ].sort((left, right) => right.root.length - left.root.length);

  for (const reference of activity) {
    const owner = roots.find((candidate) => pathWithin(candidate.root, reference.path));
    let dependency: DependencyReference;
    if (!owner) {
      dependency = { logicalPath: reference.path, source: "external", required: true };
    } else {
      const logicalPath = relative(owner.root, reference.path).split(sep).join("/");
      if (!logicalPath || logicalPath.startsWith("../")) continue;
      if (owner.kind === "drop" || owner.kind === "memory") {
        const entry = entries.find((candidate) => candidate.namespace === owner.namespace &&
          candidate.logicalPath === (owner.kind === "memory" ? `portable-memory/v1/${logicalPath}` : logicalPath));
        dependency = {
          logicalPath: `${owner.id}/${logicalPath}`,
          source: owner.kind,
          ...(entry ? { contentDigest: entry.contentDigest } : {}),
          required: true,
        };
      } else {
        const matchingCapture = captured ?? workspaceCaptureFromScan(scanned, owner.id);
        const record = matchingCapture?.capsule.records.find((candidate) => candidate.path === logicalPath);
        const oid = record?.worktree.state === "content" || record?.worktree.state === "submodule"
          ? record.worktree.oid
          : record?.worktree.state === "index" && (record.index.state === "content" || record.index.state === "submodule")
            ? record.index.oid
            : undefined;
        const overlayEntry = oid ? entries.find((candidate) =>
          candidate.namespace === `workspace:${owner.id}` && candidate.entryType === "workspace-blob" &&
          candidate.workspacePath === logicalPath && gitBlobOidFromLogicalPath(candidate.logicalPath) === oid) : undefined;
        if (record) {
          dependency = {
            logicalPath,
            source: "workspace-overlay",
            ...(overlayEntry ? { contentDigest: overlayEntry.contentDigest } : {}),
            ...(oid ? { gitObjectId: oid } : {}),
            required: true,
          };
        } else {
          const gitObjectId = matchingCapture?.capsule.baseCommit
            ? await baselineObjectId(owner.root, matchingCapture.capsule.baseCommit, logicalPath)
            : undefined;
          dependency = {
            logicalPath,
            source: gitObjectId ? "git-baseline" : "workspace-overlay",
            ...(gitObjectId ? { gitObjectId } : {}),
            required: true,
          };
        }
      }
    }
    const identity = `${dependency.source}\0${dependency.logicalPath}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      output.push(dependency);
    }
  }
  return output.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, "en") || left.source.localeCompare(right.source, "en"));
}

async function baselineObjectId(root: string, commit: string, logicalPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await runFile("git", ["-C", root, "ls-tree", "-z", commit, "--", logicalPath], { encoding: "buffer" });
    const match = /^(?:[0-7]{6})\s+(?:blob|commit)\s+([0-9a-f]{40,64})\t/u.exec(Buffer.from(stdout).toString("utf8"));
    return match?.[1];
  } catch {
    return undefined;
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const absolute = resolve(candidate);
  return absolute === root || absolute.startsWith(`${root}${sep}`);
}

function dependencyResolutionFailure(
  dependency: DependencyReference,
  capsule: SessionCapsuleV1,
  harnessManifest: VaultManifestV1 | undefined,
  workspaceManifest: VaultManifestV1 | undefined,
  dropManifests: ReadonlyMap<string, VaultManifestV1 | undefined>,
  memoryManifests: ReadonlyMap<string, VaultManifestV1 | undefined>,
): string | undefined {
  if (!harnessManifest?.entries.some((entry) =>
    entry.namespace === capsule.harness.namespace && entry.logicalPath === capsule.harness.logicalPath)) {
    return "pinned harness revision is unavailable or does not contain the session";
  }
  if (dependency.source === "external") return "path is outside every mapped workspace and Drop";
  if (dependency.source === "git-baseline") {
    if (!dependency.gitObjectId) return "Git object identity was not captured";
    const workspaceCapsule = workspaceManifest?.entries.find((entry) =>
      entry.namespace === `workspace:${capsule.workspace.workspaceId}` && entry.entryType === "workspace-capsule");
    return workspaceCapsule ? undefined : "pinned workspace capsule revision is unavailable";
  }
  if (dependency.source === "workspace-overlay") {
    if (!dependency.contentDigest) return "referenced workspace content was excluded or absent at checkpoint time";
    const exists = workspaceManifest?.entries.some((entry) =>
      entry.namespace === `workspace:${capsule.workspace.workspaceId}` && entry.entryType === "workspace-blob" &&
      entry.workspacePath === dependency.logicalPath && entry.contentDigest === dependency.contentDigest);
    return exists ? undefined : "pinned workspace overlay object is unavailable";
  }
  const separator = dependency.logicalPath.indexOf("/");
  const dropId = separator < 0 ? dependency.logicalPath : dependency.logicalPath.slice(0, separator);
  const logicalPath = separator < 0 ? "" : dependency.logicalPath.slice(separator + 1);
  if (dependency.source === "memory") {
    const pinned = memoryManifests.get(dropId);
    const exists = dependency.contentDigest && pinned?.entries.some((entry) => entry.namespace === `memory:${dropId}` &&
      entry.entryType === "file" && entry.logicalPath === `portable-memory/v1/${logicalPath}` && entry.contentDigest === dependency.contentDigest);
    return exists ? undefined : "pinned memory revision is unavailable or does not contain the referenced content";
  }
  const manifest = dropManifests.get(dropId);
  if (!dependency.contentDigest) return "referenced Drop content was excluded or absent at checkpoint time";
  const exists = manifest?.entries.some((entry) =>
    entry.namespace === `drop:${dropId}` && entry.logicalPath === logicalPath && entry.contentDigest === dependency.contentDigest);
  return exists ? undefined : "pinned Drop revision is unavailable or does not contain the referenced content";
}

function workspaceMappings(config: LocalConfig): RootMapping[] {
  return config.workspaces.filter((workspace) => workspace.sync !== "identity-only").map((workspace) => ({
    id: `workspace_${workspace.id}`,
    kind: "drop",
    mode: "two-way",
    name: workspace.name ?? workspace.id,
    namespace: `workspace:${workspace.id}`,
    path: resolve(workspace.path),
  }));
}

function workspaceMappingId(mapping: RootMapping): string | undefined {
  if (!mapping.id.startsWith("workspace_") || !mapping.namespace.startsWith("workspace:")) return undefined;
  const id = mapping.namespace.slice("workspace:".length);
  return mapping.id === `workspace_${id}` && id.length > 0 ? id : undefined;
}

function manifestNamespaceState(manifest: VaultManifestV1 | undefined, namespace: string): NamespaceState {
  return {
    entries: manifest?.entries.filter((entry) => entry.namespace === namespace) ?? [],
    tombstones: manifest?.tombstones.filter((tombstone) => tombstone.namespace === namespace) ?? [],
  };
}

function maskMergedAppendPaths(remote: NamespaceState, base: NamespaceState, paths?: ReadonlySet<string>): NamespaceState {
  if (!paths || paths.size === 0) return remote;
  return {
    entries: [
      ...remote.entries.filter((entry) => !paths.has(entry.logicalPath)),
      ...base.entries.filter((entry) => paths.has(entry.logicalPath)),
    ],
    tombstones: [
      ...remote.tombstones.filter((entry) => !paths.has(entry.logicalPath)),
      ...base.tombstones.filter((entry) => paths.has(entry.logicalPath)),
    ],
  };
}

async function scanGitOverlay(mapping: RootMapping, workspaces: LocalConfig["workspaces"]): Promise<ScannedEntry[]> {
  const workspaceId = mapping.namespace.slice("workspace:".length);
  const gitFetch = workspaces.find((workspace) => workspace.id === workspaceId)?.gitFetch ?? "ask";
  const captured = await captureWorkspace(mapping.path, { gitFetch });
  const allowedPaths = new Set(captured.capsule.records.filter((record) => !excludedBuiltIn(record.path)).map((record) => record.path));
  const capsule = { ...captured.capsule, records: captured.capsule.records.filter((record) => allowedPaths.has(record.path)) };
  return capturedWorkspaceEntries(mapping, { capsule, blobs: captured.blobs.filter((blob) => allowedPaths.has(blob.path)) });
}

function capturedWorkspaceEntries(mapping: RootMapping, captured: CapturedWorkspace): ScannedEntry[] {
  return [
    {
      namespace: mapping.namespace,
      logicalPath: "$statecase/workspace/capsule.json",
      entryType: "workspace-capsule",
      bytes: encoder.encode(canonicalJson(captured.capsule)),
    },
    ...captured.blobs.map((blob): ScannedEntry => ({
      namespace: mapping.namespace,
      logicalPath: `$statecase/workspace/blob/${blob.layer}/${blob.oid}/${Buffer.from(blob.path).toString("base64url")}`,
      entryType: "workspace-blob",
      workspacePath: blob.path,
      workspaceLayer: blob.layer,
      fileMode: blob.mode,
      bytes: blob.bytes,
    })),
  ];
}

function gitBlobOidFromLogicalPath(path: string): string {
  const match = /^\$statecase\/workspace\/blob\/(?:index|worktree)\/([0-9a-f]{40,64})\/[A-Za-z0-9_-]+$/u.exec(path);
  if (!match) throw new Error("workspace blob identity is invalid");
  return match[1];
}

async function cleanGitDestination(root: string, path: string): Promise<boolean> {
  const logicalPath = relative(resolve(root), path).split(sep).join("/");
  try {
    await runFile("git", ["-C", root, "diff", "--quiet", "--", logicalPath]);
    await runFile("git", ["-C", root, "diff", "--cached", "--quiet", "--", logicalPath]);
    return true;
  } catch {
    return false;
  }
}

async function scanWritableMappings(
  mappings: readonly RootMapping[],
  workspaces: LocalConfig["workspaces"],
  streamSessions: boolean,
  memories: readonly RootMapping[],
): Promise<ScannedEntry[]> {
  const output: ScannedEntry[] = [];
  try {
    for (const mapping of mappings) {
      output.push(...(mapping.id.startsWith("workspace_")
        ? await scanGitOverlay(mapping, workspaces)
        : await scanMapping(mapping, workspaces, streamSessions, sessionMemoryRoots(memories, mapping.namespace))));
    }
    return output;
  } catch (error) {
    await Promise.all(output.flatMap((entry) => entry.dispose ? [entry.dispose()] : []));
    throw error;
  }
}

async function scanMapping(
  mapping: RootMapping,
  workspaces: LocalConfig["workspaces"],
  streamSessions = false,
  memories: readonly SessionMemoryRoot[] = [],
): Promise<ScannedEntry[]> {
  if (mapping.memory) return scanMemory(mapping);
  const root = resolve(mapping.path);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`sync root is not a directory: ${root}`);
  const output: ScannedEntry[] = [];
  try {
    for (const document of settingsDocuments(mapping.kind)) {
      const present = await lstat(join(root, document.nativePath)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (!present) continue;
      const snapshot = await readSettingsSnapshot(root, document);
      try {
        for (const entry of snapshot.entries) output.push({ namespace: mapping.namespace, logicalPath: entry.logicalPath, bytes: entry.bytes });
      } finally { snapshot.dispose(); }
    }
    output.push(...await scanInstructions(mapping));
    await walk(root, "", mapping, workspaces, output, streamSessions, memories);
    return output;
  } catch (error) {
    await Promise.all(output.flatMap((entry) => entry.dispose ? [entry.dispose()] : []));
    throw error;
  }
}

async function walk(
  root: string,
  relativeDirectory: string,
  mapping: RootMapping,
  workspaces: LocalConfig["workspaces"],
  output: ScannedEntry[],
  streamSessions: boolean,
  memories: readonly SessionMemoryRoot[],
): Promise<void> {
  const directory = join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const logicalPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (excludedBuiltIn(logicalPath)) continue;
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
    if (entry.isDirectory()) {
      await walk(root, logicalPath, mapping, workspaces, output, streamSessions, memories);
      continue;
    }
    const classification = harnessClassification(mapping.kind, logicalPath);
    if (classification === "excluded") continue;
    const path = join(root, ...logicalPath.split("/"));
    if (classification === "session" && streamSessions) {
      const staged = await stagePortableSession(path, workspaces, { memories });
      if (!staged) continue;
      output.push({
        namespace: mapping.namespace,
        logicalPath: staged.workspaceId
          ? `portable-sessions/${staged.workspaceId}/${basename(logicalPath)}`
          : logicalPath,
        nativeRelativePath: logicalPath,
        stagedPath: staged.path,
        nativeStagedPath: staged.nativePath,
        stagedSize: staged.size,
        dispose: staged.dispose,
        ...(staged.workspaceId ? {
          session: {
            nativeSessionId: basename(logicalPath).replace(/\.jsonl$/u, ""),
            workspaceId: staged.workspaceId,
            activity: staged.activity,
          },
        } : {}),
      });
      continue;
    }
    const before = await lstat(path);
    if (before.size > MAX_FILE_BYTES) throw new Error(`file exceeds the local safety limit: ${logicalPath}`);
    let bytes: Uint8Array = await readFile(path);
    const after = await lstat(path);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`file changed while being scanned: ${logicalPath}`);
    }
    let nativeBytes: Uint8Array | undefined;
    if (classification === "session") {
      const sessionScan = scanCompleteJsonl(bytes);
      bytes = sessionScan.acceptedPrefix;
      nativeBytes = bytes;
      if (bytes.byteLength === 0) continue;
      const cwd = sessionWorkingDirectory(sessionScan.records);
      const primaryWorkspaceId = cwd
        ? [...workspaces].sort((left, right) => right.path.length - left.path.length)
          .find((workspace) => pathWithin(resolve(workspace.path), cwd))?.id
        : undefined;
      const portable = portabilizeSession(bytes, workspaces, primaryWorkspaceId, memories);
      bytes = portable.bytes;
      if (portable.workspaceId) {
        output.push({
          namespace: mapping.namespace,
          logicalPath: `portable-sessions/${portable.workspaceId}/${basename(logicalPath)}`,
          nativeRelativePath: logicalPath,
          bytes,
          nativeBytes,
          session: {
            nativeSessionId: basename(logicalPath).replace(/\.jsonl$/u, ""),
            workspaceId: portable.workspaceId,
            activity: portable.activity,
          },
        });
        continue;
      }
    }
    output.push({ namespace: mapping.namespace, logicalPath, bytes, ...(nativeBytes ? { nativeBytes } : {}) });
  }
}

function requiredMemoryBytes(entry: ScannedEntry): Uint8Array {
  if (!entry.bytes) throw new Error(`scanned entry is not memory-backed: ${entry.logicalPath}`);
  return entry.bytes;
}

async function computeScannedDigest(dedupKey: Uint8Array, entry: ScannedEntry): Promise<string> {
  return entry.stagedPath
    ? computeObjectIdStream(dedupKey, createReadStream(entry.stagedPath))
    : computeObjectId(dedupKey, requiredMemoryBytes(entry));
}

/** Applied-file guards compare native bytes, not the portable transport form.
 * Use the captured complete prefix, never reread a live file after upload. */
async function computeNativeSnapshotDigest(dedupKey: Uint8Array, entry: ScannedEntry): Promise<string> {
  if (entry.nativeStagedPath) return computeObjectIdStream(dedupKey, createReadStream(entry.nativeStagedPath));
  if (entry.nativeBytes) return computeObjectId(dedupKey, entry.nativeBytes);
  return computeScannedDigest(dedupKey, entry);
}

function portabilizeSession(
  bytes: Uint8Array,
  workspaces: LocalConfig["workspaces"],
  primaryWorkspaceId?: string,
  memories: readonly SessionMemoryRoot[] = [],
): { bytes: Uint8Array; workspaceId?: string; activity: ActivityReference[] } {
  const decoder = new TextDecoder("utf8", { fatal: true, ignoreBOM: false });
  const records = decoder.decode(bytes).trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
  const matched = new Set<string>();
  const portableValue = (value: string) => {
    const candidates = primaryWorkspaceId ? workspaces.filter((item) => item.id === primaryWorkspaceId) : workspaces;
    const workspace = [...candidates].sort((a, b) => b.path.length - a.path.length).find((item) => {
      const root = resolve(item.path);
      return value === root || value.startsWith(`${root}${sep}`);
    });
    if (!workspace) return value;
    matched.add(workspace.id);
    const suffix = relative(resolve(workspace.path), value).split(sep).join("/");
    return `statecase://workspace/${workspace.id}${suffix ? `/${suffix}` : ""}`;
  };
  for (const record of records) transformStrings(record, portableValue);
  const memoryReferences = createMemoryReferenceRewriter(memories, "portable", matched.size === 1 ? [...matched][0] : undefined);
  const nativeMemoryReferences = createMemoryReferenceRewriter(memories, "native", matched.size === 1 ? [...matched][0] : undefined);
  const memoryRecords = records.map(memoryReferences);
  return {
    bytes: encoder.encode(`${memoryRecords.map((record) => JSON.stringify(transformStrings(record, portableValue))).join("\n")}\n`),
    activity: extractActivityReferences(memoryRecords.map(nativeMemoryReferences)),
    ...(matched.size === 1 ? { workspaceId: [...matched][0] } : {}),
  };
}

function localizeSession(bytes: Uint8Array, workspaceId: string | undefined, path: string | undefined, memories: readonly SessionMemoryRoot[]): Uint8Array {
  const decoder = new TextDecoder("utf8", { fatal: true, ignoreBOM: false });
  const memoryReferences = createMemoryReferenceRewriter(memories, "native", workspaceId);
  const records = decoder.decode(bytes).trimEnd().split("\n").map((line) => {
    const record: unknown = JSON.parse(line);
    return memoryReferences(workspaceId && path ? transformStrings(record, (value) => localizeWorkspaceUri(value, workspaceId, path)) : record);
  });
  return encoder.encode(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function transformStrings(value: unknown, transform: (value: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((entry) => transformStrings(entry, transform));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, transformStrings(entry, transform)]));
  }
  return value;
}

function portableSession(logicalPath: string): { workspaceId: string; filename: string } | undefined {
  const match = /^portable-sessions\/([^/]+)\/([^/]+)$/u.exec(logicalPath);
  return match ? { workspaceId: match[1], filename: match[2] } : undefined;
}

function sessionDestination(mapping: RootMapping, logicalPath: string, config: LocalConfig): string {
  if (mapping.memory) {
    const nativePath = memoryNativePath(logicalPath);
    if (!nativePath) throw new MemoryFormatError();
    return safeDestination(mapping.path, nativePath);
  }
  const instruction = instructionPath(mapping.kind, logicalPath);
  if (instruction) return safeDestination(mapping.path, instruction);
  const portable = portableSession(logicalPath);
  if (!portable || mapping.kind === "drop") return safeDestination(mapping.path, logicalPath);
  const boundPath = config.sessionBindings?.[sessionBindingKey(mapping.namespace, logicalPath)];
  if (boundPath !== undefined) return validatedSessionDestination(mapping, portable.filename, boundPath);
  const workspace = config.workspaces.find((candidate) => candidate.id === portable.workspaceId);
  if (!workspace) throw new Error(`workspace ${portable.workspaceId} is not mapped on this device`);
  if (mapping.kind === "claude") {
    return safeDestination(claudeProjectDirectory(mapping.path, workspace.path), portable.filename);
  }
  return safeDestination(join(mapping.path, "sessions", "statecase", portable.workspaceId), portable.filename);
}

function recordSessionBindings(config: LocalConfig, mappings: readonly RootMapping[], scanned: readonly ScannedEntry[]): void {
  const byNamespace = new Map(mappings.map((mapping) => [mapping.namespace, mapping]));
  const bindings = config.sessionBindings ??= {};
  const scannedKeys = new Set(scanned
    .filter((entry) => entry.session && entry.nativeRelativePath && portableSession(entry.logicalPath))
    .map((entry) => sessionBindingKey(entry.namespace, entry.logicalPath)));
  for (const mapping of mappings) {
    if (mapping.kind === "drop") continue;
    const prefix = `${mapping.namespace}\0portable-sessions/`;
    for (const key of Object.keys(bindings)) {
      if (key.startsWith(prefix) && !scannedKeys.has(key)) delete bindings[key];
    }
  }
  for (const entry of scanned) {
    if (!entry.session || !entry.nativeRelativePath || !portableSession(entry.logicalPath)) continue;
    const mapping = byNamespace.get(entry.namespace);
    if (!mapping || mapping.kind === "drop") continue;
    validatedSessionDestination(mapping, basename(entry.logicalPath), entry.nativeRelativePath);
    bindings[sessionBindingKey(entry.namespace, entry.logicalPath)] = entry.nativeRelativePath;
  }
}

function recordMaterializedSessionBindings(
  config: LocalConfig,
  materialized: ReadonlyArray<{ mapping: RootMapping; logicalPath: string; path: string }>,
  deletions: ReadonlyArray<{ mapping: RootMapping; logicalPath: string }>,
): void {
  const bindings = config.sessionBindings ??= {};
  for (const item of materialized) {
    if (item.mapping.kind === "drop" || !portableSession(item.logicalPath)) continue;
    const nativeRelativePath = relative(resolve(item.mapping.path), item.path).split(sep).join("/");
    validatedSessionDestination(item.mapping, basename(item.logicalPath), nativeRelativePath);
    bindings[sessionBindingKey(item.mapping.namespace, item.logicalPath)] = nativeRelativePath;
  }
  for (const item of deletions) {
    if (item.mapping.kind !== "drop" && portableSession(item.logicalPath)) {
      delete bindings[sessionBindingKey(item.mapping.namespace, item.logicalPath)];
    }
  }
}

function validatedSessionDestination(mapping: RootMapping, filename: string, nativeRelativePath: string): string {
  const destination = safeDestination(mapping.path, nativeRelativePath);
  if (basename(nativeRelativePath) !== filename || harnessClassification(mapping.kind, nativeRelativePath) !== "session") {
    throw new Error("local session binding is invalid");
  }
  return destination;
}

function assertDistinctMaterializationPaths(
  materialized: ReadonlyArray<{ mapping: RootMapping; logicalPath: string; path: string }>,
  deletions: ReadonlyArray<{ mapping: RootMapping; logicalPath: string; path: string }>,
): void {
  const claimed = new Map<string, string>();
  for (const item of [...materialized, ...deletions]) {
    const identity = `${item.mapping.namespace}\0${item.logicalPath}`;
    const existing = claimed.get(item.path);
    if (existing && existing !== identity) throw new Error("local materialization paths collide");
    claimed.set(item.path, identity);
  }
}

function harnessClassification(kind: RootMapping["kind"], path: string): "file" | "session" | "excluded" {
  if (kind === "drop") return "file";
  const classification = kind === "codex" ? classifyCodexPath(path) : classifyClaudePath(path);
  if (classification === "session") return "session";
  return classification === "skill" ? "file" : "excluded";
}

function assertRemotePathAllowed(mapping: RootMapping, logicalPath: string): void {
  if (mapping.memory) {
    if (logicalPath !== MEMORY_DESCRIPTOR_PATH && !memoryNativePath(logicalPath)) throw new MemoryFormatError();
    return;
  }
  if (mapping.id.startsWith("workspace_") && mapping.namespace.startsWith("workspace:")) return;
  if (excludedBuiltIn(logicalPath)) throw new Error("remote path is excluded by adapter policy");
  if (mapping.kind !== "drop" && portableSession(logicalPath)) return;
  if (settingsField(mapping.kind, logicalPath)) return;
  if (instructionPath(mapping.kind, logicalPath)) return;
  if (harnessClassification(mapping.kind, logicalPath) === "excluded") {
    throw new Error("remote path is excluded by adapter policy");
  }
}

function excludedBuiltIn(path: string): boolean {
  const parts = path.split("/");
  const basename = parts.at(-1) ?? "";
  return parts.some((part) => part === ".git" || part === "node_modules" || part === ".statecase") ||
    parts.some((part) => /\.statecase-transaction-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:staged|backup)$/iu.test(part)) ||
    parts.some((part) => /\.statecase-lock\.sqlite(?:$|[.-])/iu.test(part)) ||
    basename === ".env" || basename.startsWith(".env.") || basename === "auth.json" ||
    /(?:^|[._-])credentials?(?:[._-]|$)/iu.test(basename) || /\.(?:pem|key|p12|pfx)$/iu.test(basename);
}

function safeDestination(root: string, logicalPath: string): string {
  if (logicalPath.length === 0 || logicalPath.includes("\0") || logicalPath.includes("\\")) throw new Error("unsafe remote path");
  const parts = logicalPath.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) throw new Error("unsafe remote path");
  const absoluteRoot = resolve(root);
  const destination = resolve(absoluteRoot, ...parts);
  if (!destination.startsWith(`${absoluteRoot}${sep}`)) throw new Error("unsafe remote path");
  return destination;
}

async function optionalFile(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function materializedWrite(item: MaterializedEntry): WorkspaceMaterializedWrite {
  return item.sourcePath !== undefined
    ? { path: item.path, sourcePath: item.sourcePath }
    : { path: item.path, bytes: item.bytes! };
}

function transactionTargets(transaction: FileTransaction): string[] {
  return [...new Set([
    ...transaction.writes.map((write) => resolve(write.path)),
    ...(transaction.symlinks ?? []).map((link) => resolve(link.path)),
    ...transaction.deletes.map((path) => resolve(path)),
  ])].sort((left, right) => left.localeCompare(right, "en"));
}

async function assertRestoreTransactionSafe(root: string, paths: readonly string[]): Promise<void> {
  const unsafe = paths.find((path) => /(?:\.db|\.sqlite|\.sqlite3|-(?:wal|shm))$/iu.test(basename(path)));
  if (unsafe) throw new Error("in-place restore refuses SQLite, WAL, and SHM targets");
  const absoluteRoot = resolve(root);
  const rootInfo = await lstat(absoluteRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("in-place restore target root must be a real directory");
  for (const path of paths) {
    const relation = relative(absoluteRoot, path);
    if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) {
      throw new Error("in-place restore target escapes its configured root");
    }
    const parts = relation.split(sep);
    let parent = absoluteRoot;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (!info) break;
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("in-place restore refuses a symlinked or non-directory target parent");
      }
    }
  }
}

async function optionalFileDigest(
  path: string,
  keys: { dedupKey: Uint8Array },
): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`local path is not a regular file: ${path}`);
    return await computeObjectIdStream(keys.dedupKey, createReadStream(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function compareEntries(left: VaultManifestV1["entries"][number], right: VaultManifestV1["entries"][number]): number {
  return left.namespace.localeCompare(right.namespace, "en") || left.logicalPath.localeCompare(right.logicalPath, "en");
}

function isInstructionAuthorityPath(namespace: string, logicalPath: string): boolean {
  return namespace.startsWith("harness:") && logicalPath.startsWith("portable-instructions/");
}

function syncRootMappings(config: LocalConfig): RootMapping[] { return [...config.mappings, ...memoryMappings(config)]; }
function sessionMemoryRoots(memories: readonly RootMapping[], namespace: string): SessionMemoryRoot[] {
  return memories.filter((mapping) => mapping.memory?.harnessNamespace === namespace).map((mapping) => ({
    id: mapping.namespace.slice("memory:".length), path: mapping.path,
    ...(mapping.memory!.workspaceId === undefined ? {} : { workspaceId: mapping.memory!.workspaceId }),
  }));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function safeIdentifier(input: string, prefix: string): string {
  const normalized = input.replaceAll(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 200);
  return normalized.length > 0 && /^[A-Za-z0-9]/u.test(normalized) ? normalized : `${prefix}_unknown`;
}
