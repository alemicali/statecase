import { isAbsolute, relative, resolve, sep } from "node:path";
import { transformPatchPaths } from "@statecase/adapter-common";
import { memoryNativePath } from "@statecase/adapter-common/memory";

export interface SessionMemoryRoot { id: string; path: string; workspaceId?: string }
export class MemoryReferenceError extends Error {
  readonly code = "MEMORY_REFERENCE_UNRESOLVED";
  constructor() { super("session memory reference cannot be safely mapped"); this.name = "MemoryReferenceError"; }
}
const prefix = "statecase://memory/";
const pathFields = new Set(["path", "file", "file_path", "filename", "from_path", "to_path", "source_path", "target_path"]);
const tools = new Set(["read", "write", "edit", "multi_edit", "read_file", "write_file", "edit_file", "create_file",
  "delete_file", "rename_file", "move_file", "open_file", "view_image", "glob", "grep", "search_files"]);
const toolTypes = new Set(["tool_call", "tool_use", "tool_request", "function_call", "function_use", "function_request", "custom_tool_call"]);
const terminalTypes = new Set(["text", "input_text", "output_text", "tool_result", "function_call_output", "custom_tool_call_output"]);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function suffixAllowed(suffix: string): boolean {
  return suffix === "" || memoryNativePath(`portable-memory/v1/${suffix}`) !== undefined ||
    memoryNativePath(`portable-memory/v1/${suffix}/reference.md`) !== undefined;
}
function observedCwd(record: unknown): string | undefined {
  if (!object(record)) return undefined;
  const type = typeof record.type === "string" ? record.type : "";
  const claude = ["assistant", "user"].includes(type) && object(record.message) && record.message.role === type;
  const metadata = ["session_meta", "session_start", "cwd", "cwd_changed", "turn_context"].includes(type);
  if (!claude && !metadata) return undefined;
  const payload = metadata && object(record.payload) ? record.payload : undefined;
  const candidate = [record.cwd, record.working_directory, payload?.cwd, payload?.working_directory].find((value) => value !== undefined);
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.length > 4096 ||
      [...candidate].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new MemoryReferenceError();
  return resolve(candidate);
}

/** Compile once per streamed file. Only reviewed tool path fields change;
 * user prose, tool outputs, edit replacements and written content never do. */
export function createMemoryReferenceRewriter(
  memories: readonly SessionMemoryRoot[], direction: "portable" | "native", workspaceId?: string,
): (record: unknown) => unknown {
  const roots = memories.map((memory) => ({ ...memory, path: resolve(memory.path) }));
  if (roots.length > 128 || new Set(roots.map((root) => root.id)).size !== roots.length ||
      memories.some((root) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(root.id) || !isAbsolute(root.path))) throw new MemoryReferenceError();
  let cwd: string | undefined;
  const mapPath = (value: string): string => {
    if (direction === "native") {
      if (!value.startsWith(prefix)) return value;
      const [id, ...parts] = value.slice(prefix.length).split("/");
      const root = roots.find((item) => item.id === id), suffix = parts.join("/");
      if (!root || (parts.length > 0 && !suffix) || !suffixAllowed(suffix) ||
          (root.workspaceId !== undefined && root.workspaceId !== workspaceId)) throw new MemoryReferenceError();
      return suffix ? resolve(root.path, ...parts) : root.path;
    }
    if (value.startsWith(prefix)) throw new MemoryReferenceError();
    const absolute = isAbsolute(value);
    if (!absolute && roots.length === 0) return value;
    if (!absolute && !cwd) throw new MemoryReferenceError();
    const candidate = absolute ? value : resolve(cwd!, value);
    const matches = roots.filter((root) => candidate === root.path || candidate.startsWith(`${root.path}${sep}`));
    if (matches.length === 0) return value;
    if (matches.length !== 1) throw new MemoryReferenceError();
    const root = matches[0]!, suffix = relative(root.path, candidate).split(sep).join("/");
    if (!absolute) {
      const spelling = value.replace(/^(?:\.\/)+/u, "").replace(/^\.$/u, "");
      // Allow canonical parent-relative paths; do not collapse traversals or
      // duplicate separators whose filesystem meaning could involve aliases.
      if (relative(cwd!, candidate).split(sep).join("/") !== spelling) throw new MemoryReferenceError();
    }
    // Do not normalize away traversal before validating the observed native path.
    const rawSuffix = !absolute ? suffix : value === root.path ? "" : value.slice(root.path.length + 1).split(sep).join("/");
    if (!suffixAllowed(rawSuffix) || suffix !== rawSuffix ||
        (root.workspaceId !== undefined && root.workspaceId !== workspaceId)) throw new MemoryReferenceError();
    return `${prefix}${root.id}${suffix ? `/${suffix}` : ""}`;
  };
  const mentionsReference = (value: string) => value.includes(prefix) ||
    (direction === "portable" && roots.some((root) => value.includes(root.path)));
  return (record) => {
    if (direction === "portable" && roots.length > 0) cwd = observedCwd(record) ?? cwd;
    let nodes = 0;
    const visit = (value: unknown, depth: number): unknown => {
      if (++nodes > 100_000 || depth > 64) throw new MemoryReferenceError();
      if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
      if (!object(value)) return value;
      if (value.role === "user" || terminalTypes.has(String(value.type))) return value;
      if (toolTypes.has(String(value.type))) {
        const nested = object(value.function) ? value.function : undefined;
        const name = value.name ?? value.tool ?? value.tool_name ?? nested?.name;
        const field = ["arguments", "input", "parameters"].find((key) => value[key] !== undefined);
        const raw = field ? value[field] : nested?.arguments;
        if (name === "apply_patch" && typeof raw === "string") {
          const mapped = transformPatchPaths(raw, mapPath);
          if (mapped === undefined) {
            if (mentionsReference(raw) || (direction === "portable" && roots.length > 0)) throw new MemoryReferenceError();
            return value;
          }
          if (mapped === raw) return value;
          return field ? { ...value, [field]: mapped } : { ...value, function: { ...nested, arguments: mapped } };
        }
        let input = raw;
        if (typeof raw === "string") {
          try { input = JSON.parse(raw) as unknown; }
          catch { if (mentionsReference(raw)) throw new MemoryReferenceError(); return value; }
        }
        if (!object(input)) return value;
        const transformed = { ...input }; let changed = false;
        for (const [key, item] of Object.entries(input)) {
          if (!pathFields.has(key) || typeof item !== "string") continue;
          const mapped = mapPath(item);
          if (mapped !== item) { transformed[key] = mapped; changed = true; }
        }
        if (!changed) return value;
        const normalizedName = typeof name === "string" ? name.replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase() : "";
        if (!tools.has(normalizedName)) throw new MemoryReferenceError();
        const result = typeof raw === "string" ? JSON.stringify(transformed) : transformed;
        return field ? { ...value, [field]: result } : { ...value, function: { ...nested, arguments: result } };
      }
      // Only native envelope fields can contain events. Never descend into
      // arbitrary tool results, artifact JSON, metadata or user message bodies.
      return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, ["payload", "message", "content"].includes(key) ? visit(item, depth + 1) : item]));
    };
    return visit(record, 0);
  };
}
