import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { LocalConfig, MemoryIdentity, RootMapping } from "./config.js";

export class MemoryBindingError extends Error {
  readonly code = "MEMORY_BINDING_INVALID";
  constructor() { super("memory binding is invalid or has conflicting ownership"); this.name = "MemoryBindingError"; }
}

/** Pure opt-in identity resolution. Does not inspect any native directory or
 * change native memory settings. Paths are local; only IDs identify peers. */
export function memoryMappings(config: LocalConfig): RootMapping[] {
  const bindings = config.memories === undefined ? [] : config.memories;
  if (!Array.isArray(bindings) || bindings.length > 128) throw new MemoryBindingError();
  const mappings: RootMapping[] = [];
  const namespaces = new Set(config.mappings.map((mapping) => mapping.namespace));
  for (const binding of bindings) {
    if (!binding || typeof binding.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(binding.id) ||
        !["claude-project", "codex-global"].includes(binding.kind) ||
        !["two-way", "publish", "consume", "append"].includes(binding.mode) ||
        typeof binding.path !== "string" || !isAbsolute(binding.path) || [...binding.path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        binding.path.length > 4096 || (binding.name !== undefined && (typeof binding.name !== "string" || binding.name.length > 256))) throw new MemoryBindingError();
    const harnesses = config.mappings.filter((mapping) => mapping.namespace === binding.harnessNamespace);
    const expected = binding.kind === "claude-project" ? "claude" : "codex";
    if (harnesses.length !== 1 || harnesses[0]!.kind !== expected ||
        (binding.kind === "claude-project" ? config.workspaces.filter((workspace) => workspace.id === binding.workspaceId).length !== 1 : binding.workspaceId !== undefined)) throw new MemoryBindingError();
    const path = resolve(binding.path), namespace = `memory:${binding.id}`;
    if (path === parse(path).root || namespaces.has(namespace) ||
        mappings.some((mapping) => overlaps(path, mapping.path)) ||
        config.mappings.some((mapping) => mapping.kind === "drop" ? overlaps(path, mapping.path) : contains(path, resolve(mapping.path))) ||
        config.workspaces.some((workspace) => overlaps(path, workspace.path))) throw new MemoryBindingError();
    const memory: MemoryIdentity = { kind: binding.kind, harnessNamespace: binding.harnessNamespace,
      ...(binding.workspaceId === undefined ? {} : { workspaceId: binding.workspaceId }) };
    namespaces.add(namespace);
    mappings.push({ id: `memory_${binding.id}`, kind: "drop", mode: binding.mode, name: binding.name ?? binding.id, namespace, path, memory });
  }
  return mappings;
}
function contains(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
function overlaps(first: string, second: string): boolean { return contains(first, resolve(second)) || contains(resolve(second), first); }
