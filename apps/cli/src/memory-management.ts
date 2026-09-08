import { resolve } from "node:path";
import { canonicalJson } from "@statecase/protocol";
import type { LocalConfig, MemoryBinding } from "./config.js";
import { memoryMappings } from "./memory-bindings.js";
import { MEMORY_DESCRIPTOR_PATH, scanMemory } from "./memory-sync.js";
import { StatecaseUsageError } from "./runtime.js";

export interface MemoryMapOptions { kind?: string; harness?: string; workspace?: string; mode?: string; name?: string }

/** Enrollment changes local selection only. It neither authorizes remote keys
 * nor enables native memory generation or changes harness settings. */
export async function planMemoryMap(config: LocalConfig, id: string, path: string, options: MemoryMapOptions) {
  memoryMappings(config);
  const previous = config.memories?.find((memory) => memory.id === id);
  if (previous && ((options.kind !== undefined && options.kind !== previous.kind) ||
      (options.harness !== undefined && options.harness !== previous.harnessNamespace) ||
      (options.workspace !== undefined && options.workspace !== previous.workspaceId))) {
    throw new StatecaseUsageError("memory identity cannot change; use a new collection ID", 2);
  }
  if (!previous && (!options.kind || !options.harness)) throw new StatecaseUsageError("new memory mappings require --kind and --harness", 2);
  const workspaceId = options.workspace ?? previous?.workspaceId;
  const memory: MemoryBinding = {
    ...previous, id, path: resolve(path), name: options.name ?? previous?.name ?? id,
    kind: (options.kind ?? previous!.kind) as MemoryBinding["kind"],
    harnessNamespace: options.harness ?? previous!.harnessNamespace,
    mode: (options.mode ?? previous?.mode ?? "two-way") as MemoryBinding["mode"],
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
  const next = structuredClone(config); next.memories ??= [];
  const index = next.memories.findIndex((item) => item.id === id);
  if (index < 0) next.memories.push(memory); else next.memories.splice(index, 1, memory);
  const mapping = memoryMappings(next).find((candidate) => candidate.namespace === `memory:${id}`)!;
  const scanned = await scanMemory(mapping);
  let files = 0, bytes = 0;
  try { for (const entry of scanned) if (entry.logicalPath !== MEMORY_DESCRIPTOR_PATH) { files++; bytes += entry.bytes.byteLength; } }
  finally { await Promise.all(scanned.map((entry) => entry.dispose())); }
  const changed = canonicalJson(previous ?? null) !== canonicalJson(memory);
  const rebound = !previous || resolve(previous.path) !== memory.path;
  const appliedReset = rebound && next.applied[mapping.namespace] !== undefined;
  if (rebound) delete next.applied[mapping.namespace];
  return { config: next, result: { memory: { ...memory, namespace: mapping.namespace }, changed, appliedReset,
    files, bytes, nativeLocationVerified: false as const, requiresDaemonRestart: changed && rebound } };
}

export function planMemoryRemoval(config: LocalConfig, id: string) {
  memoryMappings(config);
  const memory = config.memories?.find((item) => item.id === id);
  if (!memory) throw new StatecaseUsageError("memory collection is not mapped on this device", 2);
  const next = structuredClone(config);
  next.memories = next.memories!.filter((item) => item.id !== id);
  delete next.applied[`memory:${id}`];
  return { config: next, result: { id, namespace: `memory:${id}`, path: memory.path, changed: true,
    localFilesDeleted: false, remoteStateChanged: false, requiresDaemonRestart: true } };
}
