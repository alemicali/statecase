import { posix } from "node:path";

export interface InstructionPolicy { readonly files: readonly string[]; readonly trees: readonly string[]; readonly imports: boolean }
export const MAX_INSTRUCTION_BYTES = 1024 * 1024;
export const MAX_INSTRUCTION_FILES = 256;
export const MAX_INSTRUCTION_SET_BYTES = 8 * 1024 * 1024;
const PREFIX = "portable-instructions/v1/";
export class InstructionError extends Error {
  constructor(readonly code: "INSTRUCTION_FORMAT_INVALID" | "INSTRUCTION_DEPENDENCY_UNRESOLVED" | "INSTRUCTION_AUTHORITY_UNVERIFIED") {
    super(code === "INSTRUCTION_AUTHORITY_UNVERIFIED" ? "instruction changes require server-verified full-write authority" : code === "INSTRUCTION_FORMAT_INVALID" ? "instruction context is invalid or exceeds its limits" : "instruction imports are incomplete or outside reviewed context roots");
    this.name = "InstructionError";
  }
}

export function instructionLogicalPath(policy: InstructionPolicy, path: string): string {
  if (!allowed(policy, path)) throw new InstructionError("INSTRUCTION_FORMAT_INVALID");
  return PREFIX + path;
}
export function instructionNativePath(policy: InstructionPolicy, logicalPath: string): string | undefined {
  const path = logicalPath.startsWith(PREFIX) ? logicalPath.slice(PREFIX.length) : "";
  return allowed(policy, path) ? path : undefined;
}
function allowed(policy: InstructionPolicy, path: string): boolean {
  const parts = path.split("/");
  if (!path || Buffer.byteLength(path) > 1024 || parts.length > 16 ||
      parts.some((part) => !/^[\p{L}\p{N}_-][\p{L}\p{N}._ -]*$/u.test(part) || /(?:^|[._-])credentials?(?:[._-]|$)/iu.test(part))) return false;
  return policy.files.includes(path) || (path.endsWith(".md") && policy.trees.some((tree) => path.startsWith(`${tree}/`)));
}

/** Validate the entire authenticated set, not just an importing entrypoint.
 * Unknown/external dependencies fail closed; no referenced file is read here.
 */
export function validateInstructionSet(policy: InstructionPolicy, files: ReadonlyMap<string, Uint8Array>): void {
  if (files.size > MAX_INSTRUCTION_FILES) throw new InstructionError("INSTRUCTION_FORMAT_INVALID");
  const edges = new Map<string, Set<string>>(); let total = 0, imports = 0;
  for (const [path, bytes] of files) {
    total += bytes.byteLength;
    if (!allowed(policy, path) || bytes.byteLength > MAX_INSTRUCTION_BYTES || total > MAX_INSTRUCTION_SET_BYTES) throw new InstructionError("INSTRUCTION_FORMAT_INVALID");
    let text: string;
    try { text = new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { throw new InstructionError("INSTRUCTION_FORMAT_INVALID"); }
    if (text.includes("\0")) throw new InstructionError("INSTRUCTION_FORMAT_INVALID");
    const dependencies = new Set<string>();
    if (policy.imports) {
      for (const match of withoutCode(text).matchAll(/(?:^|[^\p{L}\p{N}_@])@(\S*)/gu)) {
        if (++imports > 4096) throw new InstructionError("INSTRUCTION_FORMAT_INVALID");
        const token = match[1]!;
        const dependency = posix.normalize(posix.join(posix.dirname(path), token));
        if (token.startsWith("/") || token.startsWith("~") || !allowed(policy, dependency) || !files.has(dependency)) {
          throw new InstructionError("INSTRUCTION_DEPENDENCY_UNRESOLVED");
        }
        dependencies.add(dependency);
      }
    }
    edges.set(path, dependencies);
  }
  const heights = new Map<string, number>();
  const visit = (path: string, chain: Set<string>): number => {
    if (chain.has(path) || chain.size > 4) throw new InstructionError("INSTRUCTION_DEPENDENCY_UNRESOLVED");
    const memo = heights.get(path); if (memo !== undefined) return memo;
    const next = new Set(chain).add(path);
    let height = 0;
    for (const dependency of edges.get(path)!) height = Math.max(height, 1 + visit(dependency, next));
    if (height > 4) throw new InstructionError("INSTRUCTION_DEPENDENCY_UNRESOLVED");
    heights.set(path, height); return height;
  };
  for (const path of edges.keys()) visit(path, new Set());
}

// Conservative supported import syntax: unquoted whitespace-delimited paths.
// Ambiguous punctuation/escaping fails registry validation instead of silently
// accepting a different dependency. Ignore fenced blocks and inline code spans.
function withoutCode(text: string): string {
  let fence: string | undefined;
  const lines = text.split("\n").map((line) => {
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (run && run[1]![0] === fence[0] && run[1]!.length >= fence.length && !run[2]!.trim()) fence = undefined;
      return "";
    }
    if (run) { fence = run[1]; return ""; }
    return line;
  }).join("\n");
  const runs = [...lines.matchAll(/`+/gu)];
  if (runs.length > 8192) throw new InstructionError("INSTRUCTION_FORMAT_INVALID");
  const next = new Map<number, number>(), paired = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index--) {
    const length = runs[index]![0].length, closing = next.get(length);
    if (closing !== undefined) paired.set(index, closing);
    next.set(length, index);
  }
  const output: string[] = []; let cursor = 0;
  for (let index = 0; index < runs.length; index++) {
    const closing = paired.get(index); if (closing === undefined) continue;
    output.push(lines.slice(cursor, runs[index]!.index), " ");
    cursor = runs[closing]!.index + runs[closing]![0].length; index = closing;
  }
  output.push(lines.slice(cursor)); return output.join("");
}
