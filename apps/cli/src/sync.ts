import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { classifyClaudePath, claudeProjectDirectory } from "@statecase/adapter-claude";
import { classifyCodexPath } from "@statecase/adapter-codex";
import { scanCompleteJsonl } from "@statecase/adapter-common";
import { chunkBytes, concatChunks } from "@statecase/chunking";
import { computeObjectId, decryptEnvelope, deriveScopeKey, encryptEnvelope } from "@statecase/crypto";
import { canonicalJson, manifestSchema, type VaultManifestV1 } from "@statecase/protocol";
import { appendOnlyViolations, mergeNamespace, namespaceStateEquals, type NamespaceState } from "@statecase/sync-core";
import {
  applyWorkspaceTransaction,
  assertWorkspaceDestination,
  captureWorkspace,
  type CapturedWorkspace,
  type WorkspaceBlob,
  workspaceMatchesCapsule,
} from "@statecase/workspace";

import type { LocalConfig, RootMapping } from "./config.js";
import type { StatecaseClient } from "./client.js";
import { applyFileTransaction } from "./materialize.js";

const encoder = new TextEncoder();
const runFile = promisify(execFile);
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const CHUNK_POLICY = { strategy: "fastcdc" as const, minSize: 1024 * 1024, targetSize: 4 * 1024 * 1024, maxSize: 8 * 1024 * 1024 };

interface ScannedEntry {
  namespace: string;
  logicalPath: string;
  bytes: Uint8Array;
  entryType?: "file" | "workspace-capsule" | "workspace-blob";
  workspacePath?: string;
  workspaceLayer?: "index" | "worktree";
  fileMode?: number;
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

export class SyncEngine {
  constructor(
    readonly client: StatecaseClient,
    readonly vaultId: string,
    readonly vaultKey: Uint8Array,
  ) {
    if (vaultKey.byteLength !== 32) throw new TypeError("invalid vault key");
  }

  async push(
    config: LocalConfig,
    dryRun = false,
    options: { resolveLocalNamespaces?: ReadonlySet<string>; expectedHeadRevisionId?: string } = {},
  ): Promise<SyncResult> {
    const writable = [
      ...config.mappings.filter((mapping) => mapping.mode !== "consume"),
      ...workspaceMappings(config),
    ];
    const scanned = (await Promise.all(writable.map((mapping) =>
      mapping.id.startsWith("workspace_") ? scanGitOverlay(mapping) : scanMapping(mapping, config.workspaces)
    ))).flat();
    const head = await this.client.head(this.vaultId);
    if (options.expectedHeadRevisionId !== undefined && head.revisionId !== options.expectedHeadRevisionId) {
      throw new SyncConflict([`${this.vaultId}:head-advanced-before-resolution`]);
    }
    const previous = head.manifestObjectId ? await this.#downloadManifest(head.manifestObjectId) : undefined;
    const writableNamespaces = new Set(writable.map((mapping) => mapping.namespace));
    if (writableNamespaces.size !== writable.length) throw new Error("duplicate writable namespace mapping");
    const plaintextChunks = new Map<string, { bytes: Uint8Array; namespace: string }>();
    const localEntries: VaultManifestV1["entries"] = [];
    for (const file of scanned) {
      const keys = await deriveScopeKey(this.vaultKey, file.namespace);
      const objectIds: string[] = [];
      for (const chunk of chunkBytes(file.bytes, CHUNK_POLICY)) {
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
        totalSize: file.bytes.byteLength,
        contentDigest: await computeObjectId(keys.dedupKey, file.bytes),
      });
    }
    const entries = previous?.entries.filter((entry) => !writableNamespaces.has(entry.namespace)) ?? [];
    const tombstones = previous?.tombstones.filter((item) => !writableNamespaces.has(item.namespace)) ?? [];
    const completelyLocalNamespaces = new Set<string>();
    const manifests = new Map<string, VaultManifestV1>();
    if (head.revisionId && previous) manifests.set(head.revisionId, previous);
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
    const conflicts = previous?.conflicts ?? [];
    if (previous && canonicalJson({ entries, tombstones, conflicts }) === canonicalJson({
      entries: previous.entries,
      tombstones: previous.tombstones,
      conflicts: previous.conflicts,
    })) {
      await this.#markApplied(config, writable.filter((mapping) => completelyLocalNamespaces.has(mapping.namespace)), scanned, head.revisionId!);
      return { outcome: "unchanged", revisionId: head.revisionId, files: 0, objects: 0, bytes: 0 };
    }
    const envelopes = new Map<string, Uint8Array>();
    let transferredBytes = 0;
    for (const [objectId, chunk] of plaintextChunks) {
      const keys = await deriveScopeKey(this.vaultKey, chunk.namespace);
      const envelope = await encryptEnvelope({
        plaintext: chunk.bytes,
        key: keys.encryptionKey,
        dedupKey: keys.dedupKey,
        context: { vaultId: this.vaultId, scopeId: chunk.namespace, compression: "none" },
      });
      envelopes.set(objectId, envelope);
      transferredBytes += envelope.byteLength;
    }
    const operationId = randomId("op");
    const revisionId = randomId("rev");
    const manifest: VaultManifestV1 = {
      schemaVersion: 1,
      vaultId: this.vaultId,
      revisionId,
      parentRevisionIds: head.revisionId ? [head.revisionId] : [],
      createdAt: new Date().toISOString(),
      createdByDeviceId: config.deviceId ?? (config.deviceName ? safeIdentifier(config.deviceName, "device") : "device_unknown"),
      operationId,
      entries,
      tombstones,
      conflicts,
    };
    const manifestBytes = encoder.encode(canonicalJson(manifest));
    const manifestKeys = await deriveScopeKey(this.vaultKey, "manifest");
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
    await this.#markApplied(config, writable.filter((mapping) => completelyLocalNamespaces.has(mapping.namespace)), scanned, revisionId);
    return { outcome: "pushed", revisionId, files: scanned.length, objects: envelopes.size + 1, bytes: transferredBytes + manifestEnvelope.byteLength };
  }

  async pull(config: LocalConfig, dryRun = false, historicalRevisionId?: string): Promise<SyncResult> {
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
    const byNamespace = new Map(selected.map((mapping) => [mapping.namespace, mapping]));
    const materialized: Array<{ mapping: RootMapping; path: string; bytes: Uint8Array; digest: string }> = [];
    const deletions: Array<{ mapping: RootMapping; path: string; logicalPath: string }> = [];
    const workspacePayloads = new Map<string, { mapping: RootMapping; capsule?: CapturedWorkspace["capsule"]; blobs: WorkspaceBlob[] }>();
    let objectCount = 1;
    let byteCount = 0;
    for (const entry of manifest.entries) {
      const mapping = byNamespace.get(entry.namespace);
      if (!mapping) continue;
      const keys = await deriveScopeKey(this.vaultKey, entry.namespace);
      const chunks: Uint8Array[] = [];
      for (const objectId of entry.objectIds) {
        const envelope = await this.client.getObject(this.vaultId, objectId);
        byteCount += envelope.byteLength;
        objectCount += 1;
        chunks.push(await decryptEnvelope({
          envelope,
          key: keys.encryptionKey,
          dedupKey: keys.dedupKey,
          expected: { vaultId: this.vaultId, scopeId: entry.namespace, compression: "none" },
        }));
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
      const portable = portableSession(entry.logicalPath);
      if (portable && mapping.kind !== "drop") {
        const workspace = config.workspaces.find((candidate) => candidate.id === portable.workspaceId);
        if (!workspace) continue;
        bytes = localizeSession(bytes, portable.workspaceId, resolve(workspace.path));
      }
      const localDigest = await computeObjectId(keys.dedupKey, bytes);
      materialized.push({
        mapping,
        path: sessionDestination(mapping, entry.logicalPath, config.workspaces),
        bytes,
        digest: localDigest,
      });
    }
    for (const tombstone of manifest.tombstones) {
      const mapping = byNamespace.get(tombstone.namespace);
      if (!mapping) continue;
      deletions.push({
        mapping,
        path: sessionDestination(mapping, tombstone.logicalPath, config.workspaces),
        logicalPath: tombstone.logicalPath,
      });
    }

    const readyWorkspaces: Array<{ mapping: RootMapping; captured: CapturedWorkspace }> = [];
    for (const payload of workspacePayloads.values()) {
      if (!payload.capsule) throw new Error("workspace capsule metadata is missing");
      const captured = { capsule: payload.capsule, blobs: payload.blobs };
      if (await workspaceMatchesCapsule(payload.mapping.path, captured)) continue;
      try {
        await assertWorkspaceDestination(payload.mapping.path, captured);
      } catch {
        throw new SyncConflict([payload.mapping.path]);
      }
      readyWorkspaces.push({ mapping: payload.mapping, captured });
    }

    const conflicts: string[] = [];
    for (const item of materialized) {
      const current = await optionalFile(item.path);
      if (!current || bytesEqual(current, item.bytes)) continue;
      const keys = await deriveScopeKey(this.vaultKey, item.mapping.namespace);
      const currentDigest = await computeObjectId(keys.dedupKey, current);
      const prior = config.applied[item.mapping.namespace]?.digests[item.path.slice(resolve(item.mapping.path).length + 1).split(sep).join("/")];
      if (currentDigest !== prior && !(item.mapping.id.startsWith("workspace_") && !prior && await cleanGitDestination(item.mapping.path, item.path))) {
        conflicts.push(item.path);
      }
    }
    for (const item of deletions) {
      const current = await optionalFile(item.path);
      if (!current) continue;
      const keys = await deriveScopeKey(this.vaultKey, item.mapping.namespace);
      const currentDigest = await computeObjectId(keys.dedupKey, current);
      const relativePath = relative(resolve(item.mapping.path), item.path).split(sep).join("/");
      const prior = config.applied[item.mapping.namespace]?.digests[relativePath];
      if (!prior || currentDigest !== prior) conflicts.push(item.path);
    }
    if (conflicts.length > 0) throw new SyncConflict(conflicts);
    const workspaceFiles = readyWorkspaces.reduce((total, item) => total + item.captured.capsule.records.length, 0);
    if (dryRun) return { outcome: "pulled", revisionId: head.revisionId, files: materialized.length + deletions.length + workspaceFiles, objects: objectCount, bytes: byteCount };

    await applyWorkspaceTransaction(
      readyWorkspaces.map((workspace) => ({ root: workspace.mapping.path, captured: workspace.captured })),
      {
        writes: materialized.map((item) => ({ path: item.path, bytes: item.bytes })),
        deletes: deletions.map((item) => item.path),
      },
      { materialize: applyFileTransaction },
    );
    for (const mapping of selected) {
      const digests: Record<string, string> = {};
      for (const item of materialized.filter((candidate) => candidate.mapping.namespace === mapping.namespace)) {
        digests[relative(resolve(mapping.path), item.path).split(sep).join("/")] = item.digest;
      }
      config.applied[mapping.namespace] = { revisionId: head.revisionId, digests };
    }
    return { outcome: "pulled", revisionId: head.revisionId, files: materialized.length + deletions.length + workspaceFiles, objects: objectCount, bytes: byteCount };
  }

  async #downloadManifest(objectId: string): Promise<VaultManifestV1> {
    const envelope = await this.client.getObject(this.vaultId, objectId);
    const keys = await deriveScopeKey(this.vaultKey, "manifest");
    const plaintext = await decryptEnvelope({
      envelope,
      key: keys.encryptionKey,
      dedupKey: keys.dedupKey,
      expected: { vaultId: this.vaultId, scopeId: "manifest", compression: "none" },
    });
    return manifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(plaintext)));
  }

  async #markApplied(config: LocalConfig, mappings: RootMapping[], scanned: ScannedEntry[], revisionId: string): Promise<void> {
    for (const mapping of mappings) {
      const keys = await deriveScopeKey(this.vaultKey, mapping.namespace);
      const digests: Record<string, string> = {};
      for (const file of scanned.filter((candidate) => candidate.namespace === mapping.namespace)) {
        digests[file.logicalPath] = await computeObjectId(keys.dedupKey, file.bytes);
      }
      config.applied[mapping.namespace] = { revisionId, digests };
    }
  }
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

async function scanGitOverlay(mapping: RootMapping): Promise<ScannedEntry[]> {
  const captured = await captureWorkspace(mapping.path);
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

async function scanMapping(mapping: RootMapping, workspaces: LocalConfig["workspaces"]): Promise<ScannedEntry[]> {
  const root = resolve(mapping.path);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`sync root is not a directory: ${root}`);
  const output: ScannedEntry[] = [];
  await walk(root, "", mapping, workspaces, output);
  return output;
}

async function walk(
  root: string,
  relativeDirectory: string,
  mapping: RootMapping,
  workspaces: LocalConfig["workspaces"],
  output: ScannedEntry[],
): Promise<void> {
  const directory = join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const logicalPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (excludedBuiltIn(logicalPath)) continue;
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
    if (entry.isDirectory()) {
      await walk(root, logicalPath, mapping, workspaces, output);
      continue;
    }
    const classification = harnessClassification(mapping.kind, logicalPath);
    if (classification === "excluded") continue;
    const path = join(root, ...logicalPath.split("/"));
    const before = await lstat(path);
    if (before.size > MAX_FILE_BYTES) throw new Error(`file exceeds the local safety limit: ${logicalPath}`);
    let bytes: Uint8Array = await readFile(path);
    const after = await lstat(path);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`file changed while being scanned: ${logicalPath}`);
    }
    if (classification === "session") {
      bytes = scanCompleteJsonl(bytes).acceptedPrefix;
      if (bytes.byteLength === 0) continue;
      const portable = portabilizeSession(bytes, workspaces);
      bytes = portable.bytes;
      if (portable.workspaceId) {
        output.push({ namespace: mapping.namespace, logicalPath: `portable-sessions/${portable.workspaceId}/${basename(logicalPath)}`, bytes });
        continue;
      }
    }
    output.push({ namespace: mapping.namespace, logicalPath, bytes });
  }
}

function portabilizeSession(bytes: Uint8Array, workspaces: LocalConfig["workspaces"]): { bytes: Uint8Array; workspaceId?: string } {
  const decoder = new TextDecoder("utf8", { fatal: true, ignoreBOM: false });
  const records = decoder.decode(bytes).trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
  const matched = new Set<string>();
  const transformed = records.map((record) => transformStrings(record, (value) => {
    const workspace = [...workspaces].sort((a, b) => b.path.length - a.path.length).find((item) => {
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
  const prefix = `statecase://workspace/${workspaceId}`;
  const records = decoder.decode(bytes).trimEnd().split("\n").map((line) => transformStrings(JSON.parse(line) as unknown, (value) => {
    if (value === prefix) return path;
    if (!value.startsWith(`${prefix}/`)) return value;
    return join(path, ...value.slice(prefix.length + 1).split("/"));
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

function sessionDestination(mapping: RootMapping, logicalPath: string, workspaces: LocalConfig["workspaces"]): string {
  const portable = portableSession(logicalPath);
  if (!portable || mapping.kind === "drop") return safeDestination(mapping.path, logicalPath);
  const workspace = workspaces.find((candidate) => candidate.id === portable.workspaceId);
  if (!workspace) throw new Error(`workspace ${portable.workspaceId} is not mapped on this device`);
  if (mapping.kind === "claude") {
    return safeDestination(claudeProjectDirectory(mapping.path, workspace.path), portable.filename);
  }
  return safeDestination(join(mapping.path, "sessions", "statecase", portable.workspaceId), portable.filename);
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
