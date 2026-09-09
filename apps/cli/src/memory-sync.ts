import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@statecase/protocol";
import { MemoryFormatError, memoryLogicalPath, memoryNativePath, validateMemorySet, MAX_MEMORY_FILES, MAX_MEMORY_SET_BYTES } from "@statecase/adapter-common/memory";
import type { LocalConfig, RootMapping } from "./config.js";
import { NativeFileError, readNativeFileSnapshot, type NativeFileSnapshot } from "./native-file.js";
import { prepareNativeTextPlan, type IncomingNativeText, type NativeTextPlan } from "./native-text-plan.js";

export const MEMORY_DESCRIPTOR_PATH = "portable-memory/v1/collection.json";
export class MemoryIdentityError extends Error {
  readonly code = "MEMORY_IDENTITY_MISMATCH";
  constructor() { super("memory collection identity is missing or does not match the local binding"); this.name = "MemoryIdentityError"; }
}
export interface ScannedMemory { namespace: string; logicalPath: string; bytes: Uint8Array; dispose(): Promise<void> }
export function memoryDescriptor(mapping: RootMapping): string {
  if (!mapping.memory) throw new MemoryIdentityError();
  const { kind, harnessNamespace, workspaceId } = mapping.memory;
  return canonicalJson({ version: 1, kind, harnessNamespace, ...(workspaceId === undefined ? {} : { workspaceId }) });
}

export async function scanMemory(mapping: RootMapping): Promise<ScannedMemory[]> {
  const identity = new TextEncoder().encode(memoryDescriptor(mapping));
  const snapshots = new Map<string, NativeFileSnapshot>(), guards: Array<() => Promise<void>> = [];
  let total = 0, inspected = 0;
  const walk = async (relative: string): Promise<void> => {
    if (relative) memoryLogicalPath(`${relative}/probe.md`);
    const path = join(mapping.path, relative), before = await optionalStat(path);
    if (!before) { guards.push(async () => { if (await optionalStat(path)) throw new NativeFileError("NATIVE_FILE_CHANGED"); }); return; }
    if (!before.isDirectory() || (before.mode & 0o022) !== 0 || (process.getuid && process.getuid() !== before.uid)) throw new NativeFileError("NATIVE_FILE_UNSAFE");
    const directoryIdentity = (info: typeof before) => canonicalJson([info.dev, info.ino, info.mode, info.uid, info.mtimeMs, info.ctimeMs]);
    const entries = await enumerate(path), names = entries.map((entry) => entry.name).sort().join("\0");
    guards.push(async () => {
      const after = await optionalStat(path);
      if (!after || directoryIdentity(before) !== directoryIdentity(after) || (await enumerate(path)).map((entry) => entry.name).sort().join("\0") !== names) throw new NativeFileError("NATIVE_FILE_CHANGED");
    });
    for (const entry of entries) {
      if (++inspected > 4096) throw new MemoryFormatError();
      const nativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new NativeFileError("NATIVE_FILE_UNSAFE");
      if (entry.isDirectory()) { await walk(nativePath); continue; }
      memoryLogicalPath(nativePath);
      const snapshot = await readNativeFileSnapshot(mapping.path, nativePath); snapshots.set(nativePath, snapshot);
      if (!snapshot.bytes) throw new NativeFileError("NATIVE_FILE_CHANGED");
      total += snapshot.bytes.byteLength;
      if (snapshots.size > MAX_MEMORY_FILES || total > MAX_MEMORY_SET_BYTES) throw new MemoryFormatError();
    }
  };
  try {
    await walk("");
    validateMemorySet(new Map([...snapshots].map(([path, snapshot]) => [path, snapshot.bytes!])));
    for (const snapshot of snapshots.values()) await snapshot.assertUnchanged();
    for (const guard of guards) await guard();
    return [{ namespace: mapping.namespace, logicalPath: MEMORY_DESCRIPTOR_PATH, bytes: identity, async dispose() { identity.fill(0); } },
      ...[...snapshots].sort(([a], [b]) => a.localeCompare(b, "en")).map(([path, snapshot]) => ({ namespace: mapping.namespace,
        logicalPath: memoryLogicalPath(path), bytes: snapshot.bytes!, async dispose() { snapshot.dispose(); } }))];
  } catch (error) {
    identity.fill(0); for (const snapshot of snapshots.values()) snapshot.dispose();
    if (error instanceof MemoryFormatError || error instanceof NativeFileError) throw error;
    throw new NativeFileError("NATIVE_FILE_UNSAFE");
  }
}

export async function prepareMemoryPlan(
  incoming: readonly IncomingNativeText[], config: LocalConfig,
  epoch: (namespace: string) => number,
  digest: (namespace: string, epoch: number, bytes: Uint8Array) => Promise<string>,
  selected: readonly RootMapping[] = [],
): Promise<NativeTextPlan> {
  const groups = new Map<string, IncomingNativeText[]>();
  let plan: NativeTextPlan | undefined;
  const dispose = () => { plan?.dispose(); for (const item of incoming) item.bytes?.fill(0); };
  try {
    for (const item of incoming) { const group = groups.get(item.mapping.namespace) ?? []; group.push(item); groups.set(item.mapping.namespace, group); }
    for (const mapping of selected) if (!groups.has(mapping.namespace)) throw new MemoryIdentityError();
    const descriptors: IncomingNativeText[] = [];
    for (const group of groups.values()) {
      const expected = memoryDescriptor(group[0]!.mapping), found = group.filter((item) => item.logicalPath === MEMORY_DESCRIPTOR_PATH);
      if (found.length !== 1 || !found[0]!.bytes || found[0]!.bytes.byteLength > 4096 ||
          group.some((item) => memoryDescriptor(item.mapping) !== expected)) throw new MemoryIdentityError();
      try { if (new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(found[0]!.bytes) !== expected) throw new MemoryIdentityError(); }
      catch { throw new MemoryIdentityError(); }
      descriptors.push(found[0]!);
    }
    plan = await prepareNativeTextPlan(incoming.filter((item) => item.logicalPath !== MEMORY_DESCRIPTOR_PATH), config, epoch, digest, {
      nativePath: (_mapping, path) => memoryNativePath(path), validate: (_mapping, files) => validateMemorySet(files), invalid: () => new MemoryFormatError(),
    });
    for (const item of descriptors) plan.digests.push({ namespace: item.mapping.namespace, logicalPath: item.logicalPath, digest: await digest(item.mapping.namespace, epoch(item.mapping.namespace), item.bytes!) });
    return { ...plan, dispose };
  } catch (error) { dispose(); throw error; }
}
async function enumerate(path: string) {
  const entries = [];
  // Async iteration closes the directory on success and early rejection. Do
  // not allocate an unbounded readdir array before checking the name limit.
  for await (const entry of await opendir(path, { bufferSize: 32 })) {
    if (entries.length === 4096) throw new MemoryFormatError();
    entries.push(entry);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
}
async function optionalStat(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new NativeFileError("NATIVE_FILE_UNSAFE");
  }
}
