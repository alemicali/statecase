import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { classifyClaudePath, claudeProjectDirectory } from "@statecase/adapter-claude";
import { classifyCodexPath } from "@statecase/adapter-codex";
import { extractActivityReferences, scanCompleteJsonl, sessionWorkingDirectory, type ActivityReference } from "@statecase/adapter-common";
import { chunkBytes, concatChunks } from "@statecase/chunking";
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
  captureWorkspace,
  GitLfsContentUnavailable,
  inspectWorkspaceDestination,
  type CapturedWorkspace,
  type GitFetchPolicy,
  type WorkspaceBlob,
  type WorkspaceMaterializedWrite,
  WorkspaceBaselineUnavailable,
  workspaceMatchesCapsule,
} from "@statecase/workspace";

import { sessionBindingKey, type LocalConfig, type RootMapping } from "./config.js";
import type { ScopedVaultKeys } from "./capability.js";
import type { StatecaseClient } from "./client.js";
import { isCompleteJsonlRecordSupersequence } from "./append-merge.js";
import { isCompleteJsonlFileRecordSupersequence, mergeJsonlAppendFiles } from "./append-merge-file.js";
import { applyFileTransaction } from "./materialize.js";
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

export class SyncEngine {
  readonly vaultKey?: Uint8Array;
  readonly scopedAccess?: ScopedVaultKeys;

  constructor(
    readonly client: StatecaseClient,
    readonly vaultId: string,
    access: Uint8Array | ScopedVaultKeys,
  ) {
    if (access instanceof Uint8Array) {
      if (access.byteLength !== 32) throw new TypeError("invalid vault key");
      this.vaultKey = access;
    } else {
      if (access.vaultId !== vaultId) throw new TypeError("scoped access belongs to another vault");
      this.scopedAccess = access;
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
      ...config.mappings.filter((mapping) => mapping.mode !== "consume"),
      ...workspaceMappings(config),
    ];
    const scanned = await scanWritableMappings(writable, config.workspaces, false);
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
      const dependencies = capsule.dependencies.map((dependency) => {
        const unresolved = dependencyResolutionFailure(dependency, capsule, harnessManifest, workspaceManifest, dropManifests);
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
    const writable = [...config.mappings.filter((mapping) => mapping.mode !== "consume"), ...workspaceMappings(config)];
    const unauthorized = allowed ? writable.filter((mapping) => !allowed.has(mapping.namespace)) : [];
    if (unauthorized.length > 0) {
      throw new Error(`capability does not authorize configured namespaces: ${unauthorized.map((mapping) => mapping.namespace).sort().join(", ")}`);
    }
    if (new Set(writable.map((mapping) => mapping.namespace)).size !== writable.length) throw new Error("duplicate writable namespace mapping");
    const scanned = await scanWritableMappings(writable, config.workspaces, true);
    try {
    const remote = await this.client.namespaceHeads(this.vaultId);
    if (options.expectedHeadRevisionId !== undefined && remote.revisionId !== options.expectedHeadRevisionId) {
      throw new SyncConflict([`${this.vaultId}:head-advanced-before-resolution`]);
    }
    const heads = new Map(remote.namespaces.map((head) => [head.namespace, head]));
    const operationId = randomId("op");
    const vaultRevisionId = randomId("srev");
    const createdAt = new Date().toISOString();
    const createdByDeviceId = config.deviceId ?? "capability_sandbox";
    const updates = [];
    const nextApplied = new Map<string, { revisionId: string; digests: Record<string, string> }>();
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
      encoded.digests[file.logicalPath] = contentDigest;
      encoded.entries.push({
        namespace: file.namespace,
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
    for (const mapping of writable) {
      const head = heads.get(mapping.namespace);
      if (head) remoteManifests.set(mapping.namespace, (await this.#resolveNamespaceManifest(head)).manifest);
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
    const capsuleEntries = [...encodedByNamespace.values()].flatMap((encoded) => encoded.entries);
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
      const baseState: NamespaceState = { entries: baseManifest?.entries ?? [], tombstones: baseManifest?.tombstones ?? [] };
      const remoteState: NamespaceState = { entries: remoteManifest?.entries ?? [], tombstones: remoteManifest?.tombstones ?? [] };
      const remoteObjectIds = new Set(remoteState.entries.flatMap((entry) => entry.objectIds));
      const localState = { entries: localEntries, tombstones: localTombstones };
      if (mapping.mode === "append") {
        const violations = appendOnlyViolations(baseState, localState);
        if (violations.length > 0) throw new SyncConflict(violations.map((path) => `${namespace}:${path}:append-only`));
      }
      const mergeRemoteState = maskMergedAppendPaths(remoteState, baseState, appendMergedPaths.get(namespace));
      const merged = mergeNamespace(baseState, mergeRemoteState, localState, { atomic: namespace.startsWith("workspace:") });
      if (merged.outcome === "conflict") throw new SyncConflict(merged.paths.map((path) => `${namespace}:${path}`));
      const finalState = merged.state;
      const remoteEntries = new Map(remoteState.entries.map((entry) => [entry.logicalPath, entry]));
      const finalEntries = new Map(finalState.entries.map((entry) => [entry.logicalPath, entry]));
      const changedEntries = finalState.entries.filter((entry) => remoteEntries.get(entry.logicalPath)?.contentDigest !== entry.contentDigest);
      const tombstones = remoteState.entries
        .filter((entry) => !finalEntries.has(entry.logicalPath))
        .map((entry) => finalState.tombstones.find((item) => item.logicalPath === entry.logicalPath) ?? { namespace, logicalPath: entry.logicalPath, deletedAt: createdAt });
      if (changedEntries.length === 0 && tombstones.length === 0) {
        if (head) nextApplied.set(namespace, { revisionId: head.revisionId, digests });
        continue;
      }
      const namespaceRevisionId = randomId("nrev");
      const manifestMode = appendOnly && head ? "delta" as const : "snapshot" as const;
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
        namespaceRevisionId,
        parentNamespaceRevisionIds: head ? [head.revisionId] : [],
        createdAt,
        createdByDeviceId,
        operationId,
        mode: manifestMode,
        entries: manifestEntries,
        tombstones: manifestTombstones,
        conflicts: [],
        sessionCapsules: sessionCapsules.filter((capsule) => capsule.harness.namespace === namespace),
        pathClaims,
      });
      const requiredObjectIds = [...new Set(manifest.entries.flatMap((entry) => entry.objectIds))];
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
        baseNamespaceRevisionId: head?.revisionId ?? null,
        namespaceRevisionId,
        manifestObjectId,
        requiredObjectIds,
        mode: appendOnly ? "append" as const : "replace" as const,
        pathClaims,
      });
      if (!appendMergedPaths.has(namespace) && namespaceStateEquals(finalState, localState)) {
        nextApplied.set(namespace, { revisionId: namespaceRevisionId, digests });
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
    ]);
    if (pinnedRevisions.size !== 1) throw new Error("multi-revision session hydration is not supported by this client version");

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
    warnings.sort((left, right) => left.localeCompare(right, "en"));
    if (mode === "strict" && warnings.length > 0) throw new SessionDependencyError(warnings);

    const scoped = structuredClone(config);
    scoped.applied = {};
    scoped.mappings = config.mappings
      .filter((mapping) => mapping.namespace === report.harness.namespace || (mapping.kind === "drop" && dropIds.has(mapping.id)))
      .map((mapping) => ({ ...mapping, mode: "consume" as const }));
    scoped.workspaces = workspace ? [{ ...workspace, sync: "git" }] : [];
    const revisionId = [...pinnedRevisions][0]!;
    const result = await this.pull(scoped, options.dryRun ?? false, revisionId);
    if (!options.dryRun) {
      for (const [namespace, applied] of Object.entries(scoped.applied)) config.applied[namespace] = applied;
      config.sessionBindings = scoped.sessionBindings;
    }
    return { result, report, warnings };
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
    const selected = [...config.mappings.filter((mapping) => mapping.mode !== "publish"), ...workspaceMappings(config)];
    if (!historicalRevisionId && selected.length > 0 && selected.every((mapping) => config.applied[mapping.namespace]?.revisionId === head.revisionId)) {
      return { outcome: "unchanged", revisionId: head.revisionId, files: 0, objects: 0, bytes: 0 };
    }
    const manifest = await this.#downloadManifest(head.manifestObjectId);
    if (manifest.revisionId !== head.revisionId) throw new Error("remote head and manifest revision do not match");
    return this.#materializeManifest(config, dryRun, head.revisionId, manifest, selected, 1,
      (_namespace, objectId) => this.client.getObject(this.vaultId, objectId),
      () => head.revisionId!);
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
  ): Promise<SyncResult> {
    const byNamespace = new Map(selected.map((mapping) => [mapping.namespace, mapping]));
    const materialized: MaterializedEntry[] = [];
    const deletions: Array<{ mapping: RootMapping; path: string; logicalPath: string }> = [];
    const workspacePayloads = new Map<string, { mapping: RootMapping; capsule?: CapturedWorkspace["capsule"]; blobs: WorkspaceBlob[] }>();
    let objectCount = manifestObjectCount;
    let byteCount = 0;
    const stagedDisposers: Array<() => Promise<void>> = [];
    try {
    for (const entry of manifest.entries) {
      const mapping = byNamespace.get(entry.namespace);
      if (!mapping) continue;
      const keys = await this.#scopeKeys(entry.namespace);
      const portable = portableSession(entry.logicalPath);
      const streamedSession = mapping.kind !== "drop" && (portable !== undefined || entry.chunking?.strategy === "jsonl-records");
      if (streamedSession) {
        if (entry.totalSize > MAX_STREAMED_SESSION_BYTES) throw new Error(`remote file exceeds the local safety limit: ${entry.logicalPath}`);
        const workspace = portable
          ? config.workspaces.find((candidate) => candidate.id === portable.workspaceId)
          : undefined;
        if (portable && !workspace) continue;
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
        let nativePath = staged.path;
        if (portable && workspace) {
          nativePath = join(staged.root, "localized.jsonl");
          await localizePortableSession(staged.path, nativePath, portable.workspaceId, resolve(workspace.path));
        }
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
        bytes = localizeSession(bytes, portable.workspaceId, resolve(workspace.path));
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
      deletions.push({
        mapping,
        path: sessionDestination(mapping, tombstone.logicalPath, config),
        logicalPath: tombstone.logicalPath,
      });
    }

    const readyWorkspaces: Array<{ mapping: RootMapping; captured: CapturedWorkspace; gitFetch: GitFetchPolicy }> = [];
    for (const payload of workspacePayloads.values()) {
      if (!payload.capsule) throw new Error("workspace capsule metadata is missing");
      const captured = { capsule: payload.capsule, blobs: payload.blobs };
      if (await workspaceMatchesCapsule(payload.mapping.path, captured)) continue;
      const workspaceId = payload.mapping.namespace.slice("workspace:".length);
      const gitFetch = config.workspaces.find((workspace) => workspace.id === workspaceId)?.gitFetch ?? "ask";
      try {
        await inspectWorkspaceDestination(payload.mapping.path, captured, gitFetch);
      } catch (error) {
        if (error instanceof WorkspaceBaselineUnavailable || error instanceof GitLfsContentUnavailable) throw error;
        throw new SyncConflict([payload.mapping.path]);
      }
      readyWorkspaces.push({ mapping: payload.mapping, captured, gitFetch });
    }

    assertDistinctMaterializationPaths(materialized, deletions);
    const conflicts: string[] = [];
    for (const item of materialized) {
      if (item.sourcePath !== undefined) {
        const remoteSourcePath = item.sourcePath;
        const currentDigest = await optionalFileDigest(item.path, await this.#scopeKeys(item.mapping.namespace));
        if (!currentDigest || currentDigest === item.digest) continue;
        const prior = config.applied[item.mapping.namespace]?.digests[item.logicalPath];
        const safeSessionMerge = await isCompleteJsonlFileRecordSupersequence(item.path, remoteSourcePath);
        if (currentDigest !== prior && !safeSessionMerge) conflicts.push(item.path);
        continue;
      }
      const current = await optionalFile(item.path);
      if (!current || bytesEqual(current, item.bytes)) continue;
      const keys = await this.#scopeKeys(item.mapping.namespace);
      const currentDigest = await computeObjectId(keys.dedupKey, current);
      const prior = config.applied[item.mapping.namespace]?.digests[item.logicalPath];
      const safeSessionMerge = item.mapping.kind !== "drop" && portableSession(item.logicalPath) !== undefined && isCompleteJsonlRecordSupersequence(current, item.bytes);
      if (currentDigest !== prior && !safeSessionMerge && !(item.mapping.id.startsWith("workspace_") && !prior && await cleanGitDestination(item.mapping.path, item.path))) {
        conflicts.push(item.path);
      }
    }
    for (const item of deletions) {
      const current = await optionalFile(item.path);
      if (!current) continue;
      const keys = await this.#scopeKeys(item.mapping.namespace);
      const currentDigest = await computeObjectId(keys.dedupKey, current);
      const prior = config.applied[item.mapping.namespace]?.digests[item.logicalPath];
      if (!prior || currentDigest !== prior) conflicts.push(item.path);
    }
    if (conflicts.length > 0) throw new SyncConflict(conflicts);
    const workspaceFiles = readyWorkspaces.reduce((total, item) => total + item.captured.capsule.records.length, 0);
    if (dryRun) return { outcome: "pulled", revisionId: remoteRevisionId, files: materialized.length + deletions.length + workspaceFiles, objects: objectCount, bytes: byteCount };

    await applyWorkspaceTransaction(
      readyWorkspaces.map((workspace) => ({ root: workspace.mapping.path, captured: workspace.captured, gitFetch: workspace.gitFetch })),
      {
        writes: materialized.map(materializedWrite),
        deletes: deletions.map((item) => item.path),
      },
      { materialize: applyFileTransaction },
    );
    for (const mapping of selected) {
      const digests: Record<string, string> = {};
      for (const item of materialized.filter((candidate) => candidate.mapping.namespace === mapping.namespace)) {
        digests[item.logicalPath] = item.digest;
      }
      config.applied[mapping.namespace] = { revisionId: appliedRevision(mapping.namespace), digests };
    }
    recordMaterializedSessionBindings(config, materialized, deletions);
    return { outcome: "pulled", revisionId: remoteRevisionId, files: materialized.length + deletions.length + workspaceFiles, objects: objectCount, bytes: byteCount };
    } finally {
      await Promise.all(stagedDisposers.map((dispose) => dispose()));
    }
  }

  async #pullScoped(config: LocalConfig, dryRun: boolean, historicalRevisionId?: string): Promise<SyncResult> {
    if (this.scopedAccess && this.scopedAccess.expiresAt <= Date.now()) throw new Error("scoped capability has expired");
    const remote = historicalRevisionId
      ? await this.client.scopedRevision(this.vaultId, historicalRevisionId)
      : await this.client.namespaceHeads(this.vaultId);
    const allowed = this.scopedAccess ? new Set(Object.keys(this.scopedAccess.namespaceKeys)) : undefined;
    const configured = [...config.mappings.filter((mapping) => mapping.mode !== "publish"), ...workspaceMappings(config)];
    const unauthorized = allowed ? configured.filter((mapping) => !allowed.has(mapping.namespace)) : [];
    if (unauthorized.length > 0) {
      throw new Error(`capability does not authorize configured namespaces: ${unauthorized.map((mapping) => mapping.namespace).sort().join(", ")}`);
    }
    const selected = allowed ? configured.filter((mapping) => allowed.has(mapping.namespace)) : configured;
    const heads = new Map(remote.namespaces.map((head) => [head.namespace, head]));
    const relevantHeads = selected.map((mapping) => heads.get(mapping.namespace)).filter((head) => head !== undefined);
    if (relevantHeads.length === 0) return { outcome: "unchanged", revisionId: remote.revisionId, files: 0, objects: 0, bytes: 0 };
    const missingHeads = selected.filter((mapping) => !heads.has(mapping.namespace));
    if (missingHeads.length > 0) {
      throw new Error(`namespace heads are missing for configured mappings: ${missingHeads.map((mapping) => mapping.namespace).sort().join(", ")}`);
    }
    if (selected.every((mapping) => {
      const head = heads.get(mapping.namespace);
      return head && config.applied[mapping.namespace]?.revisionId === head.revisionId;
    })) return { outcome: "unchanged", revisionId: remote.revisionId, files: 0, objects: 0, bytes: 0 };

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
    return this.#materializeManifest(config, dryRun, revisionId, combined, selected, manifestObjectCount,
      (namespace, objectId) => this.client.getNamespaceObject(this.vaultId, namespace, objectId),
      (namespace) => heads.get(namespace)!.revisionId);
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

  async #resolveNamespaceManifest(head: { namespace: string; revisionId: string; manifestObjectId: string }): Promise<{ manifest: NamespaceManifestV1; manifestObjects: number }> {
    const chain: NamespaceManifestV1[] = [];
    const seen = new Set<string>();
    let pointer = { ...head, previousRevisionId: null as string | null };
    for (let depth = 0; depth < 256; depth += 1) {
      if (seen.has(pointer.revisionId)) throw new Error("namespace manifest chain contains a cycle");
      seen.add(pointer.revisionId);
      const keys = await this.#scopeKeys(pointer.namespace);
      const envelope = await this.client.getNamespaceObject(this.vaultId, pointer.namespace, pointer.manifestObjectId);
      const plaintext = await decryptEnvelope({
        envelope,
        key: keys.encryptionKey,
        dedupKey: keys.dedupKey,
        expected: { vaultId: this.vaultId, scopeId: pointer.namespace, compression: "none" },
      });
      const manifest = namespaceManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(plaintext)));
      if (manifest.vaultId !== this.vaultId || manifest.namespace !== pointer.namespace || manifest.namespaceRevisionId !== pointer.revisionId) {
        throw new Error("namespace revision and encrypted manifest do not match");
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
    try {
      const base = await downloadVerifiedEntry({
        objectIds: baseEntry.objectIds,
        totalSize: baseEntry.totalSize,
        contentDigest: baseEntry.contentDigest,
        maximumSize: MAX_STREAMED_SESSION_BYTES,
        keys,
        vaultId: this.vaultId,
        namespace: baseEntry.namespace,
        getObject: (objectId) => this.client.getNamespaceObject(this.vaultId, baseEntry.namespace, objectId),
      });
      downloaded.push(base);
      const remote = await downloadVerifiedEntry({
        objectIds: remoteEntry.objectIds,
        totalSize: remoteEntry.totalSize,
        contentDigest: remoteEntry.contentDigest,
        maximumSize: MAX_STREAMED_SESSION_BYTES,
        keys,
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
      if (merged.outcome === "diverged") return undefined;
      try {
        const described = await describeStagedJsonl(merged.path, keys.dedupKey, JSONL_CHUNK_POLICY);
        const activity = await inspectPortableSessionActivity(merged.path, workspace.id, resolve(workspace.path));
        return { ...merged, ...described, activity };
      } catch (error) {
        await merged.dispose();
        throw error;
      }
    } finally {
      await Promise.all(downloaded.map((item) => item.dispose()));
    }
  }

  async #downloadManifest(objectId: string): Promise<VaultManifestV1> {
    const envelope = await this.client.getObject(this.vaultId, objectId);
    const keys = await this.#scopeKeys("manifest");
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
      const entries = manifest.entries.filter((entry) => entry.namespace === namespace);
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
      const requiredObjectIds = [...new Set(entries.flatMap((entry) => entry.objectIds))];
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
        baseNamespaceRevisionId: null,
        namespaceRevisionId,
        manifestObjectId,
        requiredObjectIds,
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
        digests[file.logicalPath] = await computeScannedDigest(keys.dedupKey, file);
      }
      config.applied[mapping.namespace] = { revisionId, digests };
    }
  }

  async #markNamespaceRevisions(config: LocalConfig, mappings: RootMapping[]): Promise<void> {
    if (mappings.length === 0) return;
    const heads = new Map((await this.client.namespaceHeads(this.vaultId)).namespaces.map((head) => [head.namespace, head.revisionId]));
    for (const mapping of mappings) {
      const revisionId = heads.get(mapping.namespace);
      if (revisionId && config.applied[mapping.namespace]) config.applied[mapping.namespace]!.revisionId = revisionId;
    }
  }

  async #scopeKeys(scope: string): Promise<{ encryptionKey: Uint8Array; dedupKey: Uint8Array }> {
    if (this.vaultKey) return deriveScopeKey(this.vaultKey, scope);
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
    if (priorCapsuleIndex >= 0 && priorEntry?.contentDigest === currentEntry?.contentDigest) continue;

    const workspace = input.config.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) continue;
    const captured = workspaceCaptureFromScan(input.scanned, workspaceId);
    const dependencies = await resolveActivityDependencies(session.activity, workspaceId, input.config, input.entries, input.scanned, captured);
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
      dependencies,
      createdAt: input.createdAt,
      createdByDeviceId: input.createdByDeviceId,
    };
    if (priorCapsuleIndex >= 0) capsules.splice(priorCapsuleIndex, 1, capsule);
    else capsules.push(capsule);
  }
  return capsules.sort((left, right) => left.sessionKey.localeCompare(right.sessionKey, "en"));
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
): Promise<DependencyReference[]> {
  const output: DependencyReference[] = [];
  const seen = new Set<string>();
  const roots = [
    ...config.workspaces.filter((workspace) => workspace.id === sessionWorkspaceId)
      .map((workspace) => ({ kind: "workspace" as const, id: workspace.id, root: resolve(workspace.path) })),
    ...config.mappings.filter((mapping) => mapping.kind === "drop").map((mapping) => ({ kind: "drop" as const, id: mapping.id, root: resolve(mapping.path), namespace: mapping.namespace })),
  ].sort((left, right) => right.root.length - left.root.length);

  for (const reference of activity) {
    const owner = roots.find((candidate) => pathWithin(candidate.root, reference.path));
    let dependency: DependencyReference;
    if (!owner) {
      dependency = { logicalPath: reference.path, source: "external", required: true };
    } else {
      const logicalPath = relative(owner.root, reference.path).split(sep).join("/");
      if (!logicalPath || logicalPath.startsWith("../")) continue;
      if (owner.kind === "drop") {
        const entry = entries.find((candidate) => candidate.namespace === owner.namespace && candidate.logicalPath === logicalPath);
        dependency = {
          logicalPath: `${owner.id}/${logicalPath}`,
          source: "drop",
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
  return [
    {
      namespace: mapping.namespace,
      logicalPath: "$statecase/workspace/capsule.json",
      entryType: "workspace-capsule",
      bytes: encoder.encode(canonicalJson(capsule)),
    },
    ...captured.blobs.filter((blob) => allowedPaths.has(blob.path)).map((blob): ScannedEntry => ({
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
): Promise<ScannedEntry[]> {
  const output: ScannedEntry[] = [];
  try {
    for (const mapping of mappings) {
      output.push(...(mapping.id.startsWith("workspace_")
        ? await scanGitOverlay(mapping, workspaces)
        : await scanMapping(mapping, workspaces, streamSessions)));
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
): Promise<ScannedEntry[]> {
  const root = resolve(mapping.path);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`sync root is not a directory: ${root}`);
  const output: ScannedEntry[] = [];
  try {
    await walk(root, "", mapping, workspaces, output, streamSessions);
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
): Promise<void> {
  const directory = join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const logicalPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (excludedBuiltIn(logicalPath)) continue;
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
    if (entry.isDirectory()) {
      await walk(root, logicalPath, mapping, workspaces, output, streamSessions);
      continue;
    }
    const classification = harnessClassification(mapping.kind, logicalPath);
    if (classification === "excluded") continue;
    const path = join(root, ...logicalPath.split("/"));
    if (classification === "session" && streamSessions) {
      const staged = await stagePortableSession(path, workspaces);
      if (!staged) continue;
      output.push({
        namespace: mapping.namespace,
        logicalPath: staged.workspaceId
          ? `portable-sessions/${staged.workspaceId}/${basename(logicalPath)}`
          : logicalPath,
        nativeRelativePath: logicalPath,
        stagedPath: staged.path,
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
    if (classification === "session") {
      const sessionScan = scanCompleteJsonl(bytes);
      bytes = sessionScan.acceptedPrefix;
      if (bytes.byteLength === 0) continue;
      const cwd = sessionWorkingDirectory(sessionScan.records);
      const primaryWorkspaceId = cwd
        ? [...workspaces].sort((left, right) => right.path.length - left.path.length)
          .find((workspace) => pathWithin(resolve(workspace.path), cwd))?.id
        : undefined;
      const portable = portabilizeSession(bytes, workspaces, primaryWorkspaceId);
      bytes = portable.bytes;
      if (portable.workspaceId) {
        output.push({
          namespace: mapping.namespace,
          logicalPath: `portable-sessions/${portable.workspaceId}/${basename(logicalPath)}`,
          nativeRelativePath: logicalPath,
          bytes,
          session: {
            nativeSessionId: basename(logicalPath).replace(/\.jsonl$/u, ""),
            workspaceId: portable.workspaceId,
            activity: extractActivityReferences(sessionScan.records),
          },
        });
        continue;
      }
    }
    output.push({ namespace: mapping.namespace, logicalPath, bytes });
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

function portabilizeSession(
  bytes: Uint8Array,
  workspaces: LocalConfig["workspaces"],
  primaryWorkspaceId?: string,
): { bytes: Uint8Array; workspaceId?: string } {
  const decoder = new TextDecoder("utf8", { fatal: true, ignoreBOM: false });
  const records = decoder.decode(bytes).trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
  const matched = new Set<string>();
  const transformed = records.map((record) => transformStrings(record, (value) => {
    const candidates = primaryWorkspaceId ? workspaces.filter((item) => item.id === primaryWorkspaceId) : workspaces;
    const workspace = [...candidates].sort((a, b) => b.path.length - a.path.length).find((item) => {
      const root = resolve(item.path);
      return value === root || value.startsWith(`${root}${sep}`);
    });
    if (!workspace) return value;
    matched.add(workspace.id);
    const suffix = relative(resolve(workspace.path), value).split(sep).join("/");
    return `statecase://workspace/${workspace.id}${suffix ? `/${suffix}` : ""}`;
  }));
  return {
    bytes: encoder.encode(`${transformed.map((record) => JSON.stringify(record)).join("\n")}\n`),
    ...(matched.size === 1 ? { workspaceId: [...matched][0] } : {}),
  };
}

function localizeSession(bytes: Uint8Array, workspaceId: string, path: string): Uint8Array {
  const decoder = new TextDecoder("utf8", { fatal: true, ignoreBOM: false });
  const records = decoder.decode(bytes).trimEnd().split("\n").map((line) => transformStrings(JSON.parse(line) as unknown, (value) => {
    return localizeWorkspaceUri(value, workspaceId, path);
  }));
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

function excludedBuiltIn(path: string): boolean {
  const parts = path.split("/");
  const basename = parts.at(-1) ?? "";
  return parts.some((part) => part === ".git" || part === "node_modules" || part === ".statecase") ||
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
