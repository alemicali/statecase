import { createHash } from "node:crypto";
import { isAbsolute, normalize, resolve } from "node:path";

export interface AcceptedPrefix {
  length: number;
  digest: string;
}

export interface JsonlScanResult {
  records: unknown[];
  acceptedPrefix: Uint8Array;
  deferredTail: Uint8Array;
  acceptedDigest: string;
}

export interface ActivityReference {
  path: string;
  access: "read" | "write" | "create" | "delete" | "rename";
  source: "native-event";
}

export class AdapterFormatError extends Error {
  readonly code: "MALFORMED_COMPLETE_RECORD" | "PREFIX_REWRITTEN";

  constructor(code: AdapterFormatError["code"], message: string) {
    super(message);
    this.name = "AdapterFormatError";
    this.code = code;
  }

  toJSON(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

export function scanCompleteJsonl(input: Uint8Array, previous?: AcceptedPrefix): JsonlScanResult {
  if (previous) verifyPrefix(input, previous);
  const lastNewline = input.lastIndexOf(0x0a);
  const acceptedPrefix = lastNewline < 0 ? new Uint8Array() : input.slice(0, lastNewline + 1);
  const deferredTail = lastNewline < 0 ? input.slice() : input.slice(lastNewline + 1);
  const records: unknown[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const text = decoder.decode(acceptedPrefix);
  let offset = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      offset += rawLine.length + 1;
      continue;
    }
    try {
      records.push(JSON.parse(line) as unknown);
    } catch {
      throw new AdapterFormatError("MALFORMED_COMPLETE_RECORD", `malformed complete JSONL record at byte ${offset}`);
    }
    offset += rawLine.length + 1;
  }
  return { records, acceptedPrefix, deferredTail, acceptedDigest: digest(acceptedPrefix) };
}

/**
 * Extracts path references only from structured tool events. Prompt/message
 * prose is deliberately ignored: it is untrusted narrative, not evidence that
 * the harness accessed a file.
 */
export function extractActivityReferences(records: readonly unknown[]): ActivityReference[] {
  let cwd: string | undefined;
  const output: ActivityReference[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const nextCwd = eventCwd(record);
    if (nextCwd) cwd = nextCwd;
    visitToolEvents(record, (name, input) => {
      const access = toolAccess(name);
      if (!access) return;
      for (const candidate of pathArguments(input)) {
        const path = normalizeCandidate(candidate, cwd);
        if (!path) continue;
        const key = `${access}\0${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push({ path, access, source: "native-event" });
      }
    });
  }
  return output;
}

export function sessionWorkingDirectory(records: readonly unknown[]): string | undefined {
  let cwd: string | undefined;
  for (const record of records) cwd = eventCwd(record) ?? cwd;
  return cwd;
}

function eventCwd(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  const candidates: unknown[] = [];
  if (type.includes("session") || type.includes("cwd") || type.includes("turn_context")) {
    candidates.push(value.cwd, value.working_directory);
    if (isRecord(value.payload)) candidates.push(value.payload.cwd, value.payload.working_directory);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length <= 4096 && !candidate.includes("\0") && isAbsolute(candidate)) {
      return normalize(candidate);
    }
  }
  return undefined;
}

function visitToolEvents(value: unknown, accept: (name: string, input: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitToolEvents(item, accept);
    return;
  }
  if (!isRecord(value)) return;
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  const isToolEvent = /(?:tool|function)[_-]?(?:call|use|request)/u.test(type);
  if (isToolEvent) {
    const functionRecord = isRecord(value.function) ? value.function : undefined;
    const name = [value.name, value.tool, value.tool_name, functionRecord?.name].find((item) => typeof item === "string");
    let input = value.arguments ?? value.input ?? value.parameters ?? functionRecord?.arguments;
    if (typeof input === "string") {
      const patch = name === "apply_patch" ? patchPathArguments(input) : undefined;
      if (patch) input = patch;
      else {
        try { input = JSON.parse(input) as unknown; } catch { input = undefined; }
      }
    }
    if (typeof name === "string" && input !== undefined) accept(name, input);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "text" || ((key === "content" || key === "message") && typeof item === "string")) continue;
    visitToolEvents(item, accept);
  }
}

/** Recognize the native freeform patch envelope, never headings inside added text. */
function patchPathArguments(input: string): { paths: Array<{ path: string }> } | undefined {
  const lines = input.replaceAll("\r\n", "\n").trimEnd().split("\n");
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return undefined;
  const paths: Array<{ path: string }> = [];
  let operation: string | undefined;
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(line);
    if (header) {
      operation = header[1];
      paths.push({ path: header[2] });
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (move) {
      if (operation !== "Update") return undefined;
      paths.push({ path: move[1] });
      continue;
    }
    if (!operation || operation === "Delete") return undefined;
    if (operation === "Add" ? !line.startsWith("+")
      : !/^[ +-]/u.test(line) && line !== "@@" && !line.startsWith("@@ ") && line !== "*** End of File") {
      return undefined;
    }
  }
  return { paths };
}

function pathArguments(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const output: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:path|file|file_path|filename|from_path|to_path|source_path|target_path)$/u.test(key) && typeof item === "string") {
      output.push(item);
    } else if (isRecord(item) || Array.isArray(item)) {
      output.push(...pathArgumentsFromNested(item));
    }
  }
  return output;
}

function pathArgumentsFromNested(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(pathArgumentsFromNested);
  return pathArguments(value);
}

function normalizeCandidate(candidate: string, cwd: string | undefined): string | undefined {
  if (candidate.length === 0 || candidate.length > 4096 || candidate.includes("\0")) return undefined;
  if (isAbsolute(candidate)) return normalize(candidate);
  const parts = candidate.replaceAll("\\", "/").split("/");
  if (!cwd || parts.some((part) => part === "..")) return undefined;
  return resolve(cwd, candidate);
}

function toolAccess(name: string): ActivityReference["access"] | undefined {
  const normalized = name.replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
  if (hasToolVerb(normalized, "rename", "move")) return "rename";
  if (hasToolVerb(normalized, "delete", "remove", "unlink")) return "delete";
  if (hasToolVerb(normalized, "create", "touch", "mkdir")) return "create";
  if (hasToolVerb(normalized, "write", "edit", "patch", "replace", "insert", "append")) return "write";
  if (hasToolVerb(normalized, "read", "view", "open", "load", "search", "grep", "glob", "find")) return "read";
  return undefined;
}

function hasToolVerb(name: string, ...verbs: string[]): boolean {
  return name.split(/[^a-z0-9]+/u).some((part) => verbs.includes(part));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function verifyPrefix(input: Uint8Array, previous: AcceptedPrefix): void {
  if (previous.length < 0 || previous.length > input.byteLength) {
    throw new AdapterFormatError("PREFIX_REWRITTEN", "previously accepted JSONL prefix was truncated");
  }
  const actual = digest(input.subarray(0, previous.length));
  if (actual !== previous.digest) {
    throw new AdapterFormatError("PREFIX_REWRITTEN", "previously accepted JSONL prefix was rewritten");
  }
}

function digest(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("base64url");
}
