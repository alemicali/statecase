import { scanCompleteJsonl } from "@statecase/adapter-common";
import { canonicalJson } from "@statecase/protocol";

export type JsonlAppendMergeResult =
  | { outcome: "merged"; bytes: Uint8Array; appendedRecords: number }
  | { outcome: "diverged"; reason: JsonlAppendFailure };

type JsonlAppendFailure = "prefix-rewritten" | "incomplete-record" | "malformed-record" | "order-conflict" | "limit-exceeded";

const MAX_APPEND_MERGE_BYTES = 256 * 1024 * 1024;
const MAX_APPEND_MERGE_RECORDS = 100_000;

interface RecordNode {
  key: string;
  raw: string;
  successors: Set<string>;
  indegree: number;
}

interface ParsedRecord {
  key: string;
  raw: string;
}

/**
 * Merges two complete-record JSONL appends over one byte-identical accepted
 * prefix. Record occurrences form a deterministic DAG so both branch orders
 * are retained without last-writer-wins behavior.
 */
export function mergeJsonlAppends(base: Uint8Array, remote: Uint8Array, local: Uint8Array): JsonlAppendMergeResult {
  const baseValidation = validateCompleteJsonl(base);
  if (baseValidation) return { outcome: "diverged", reason: baseValidation };
  if (!startsWith(remote, base) || !startsWith(local, base)) return { outcome: "diverged", reason: "prefix-rewritten" };

  const remoteSuffix = parseCompleteRecords(remote.subarray(base.byteLength));
  if (typeof remoteSuffix === "string") return { outcome: "diverged", reason: remoteSuffix };
  const localSuffix = parseCompleteRecords(local.subarray(base.byteLength));
  if (typeof localSuffix === "string") return { outcome: "diverged", reason: localSuffix };

  const nodes = new Map<string, RecordNode>();
  for (const sequence of [remoteSuffix, localSuffix]) {
    for (const record of sequence) {
      const existing = nodes.get(record.key);
      if (!existing) nodes.set(record.key, { ...record, successors: new Set(), indegree: 0 });
      else if (record.raw < existing.raw) existing.raw = record.raw;
    }
    for (let index = 1; index < sequence.length; index += 1) {
      const before = nodes.get(sequence[index - 1]!.key)!;
      const after = nodes.get(sequence[index]!.key)!;
      if (before.successors.has(after.key)) continue;
      before.successors.add(after.key);
      after.indegree += 1;
    }
  }

  // The union of two total orders exposes at most one frontier record per
  // branch. Keeping that tiny frontier sorted is simpler than a general heap
  // and preserves deterministic output without an unbounded queue.
  const ready: string[] = [];
  for (const node of nodes.values()) if (node.indegree === 0) insertSorted(ready, node.key);
  const ordered: RecordNode[] = [];
  for (let key = ready.shift(); key !== undefined; key = ready.shift()) {
    const node = nodes.get(key)!;
    ordered.push(node);
    for (const successorKey of node.successors) {
      const successor = nodes.get(successorKey)!;
      successor.indegree -= 1;
      if (successor.indegree === 0) insertSorted(ready, successor.key);
    }
  }
  if (ordered.length !== nodes.size) return { outcome: "diverged", reason: "order-conflict" };

  const chunks = [base, ...ordered.map((record) => new TextEncoder().encode(`${record.raw}\n`))];
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { outcome: "merged", bytes, appendedRecords: ordered.length };
}

/** True only when both values are complete valid JSONL and the next value is a byte-exact extension. */
export function isCompleteJsonlAppend(previous: Uint8Array, next: Uint8Array): boolean {
  return validateCompleteJsonl(previous) === undefined && validateCompleteJsonl(next) === undefined && startsWith(next, previous);
}

/** True when every complete record occurrence in local is retained in remote in the same order. */
export function isCompleteJsonlRecordSupersequence(local: Uint8Array, remote: Uint8Array): boolean {
  const localRecords = parseCompleteRecords(local);
  const remoteRecords = parseCompleteRecords(remote);
  if (typeof localRecords === "string" || typeof remoteRecords === "string") return false;
  if (localRecords.length > 0 && localRecords[0]!.key !== remoteRecords[0]?.key) return false;
  let localIndex = 0;
  for (const remoteRecord of remoteRecords) {
    if (remoteRecord.key === localRecords[localIndex]?.key) localIndex += 1;
  }
  return localIndex === localRecords.length;
}

function validateCompleteJsonl(bytes: Uint8Array): Exclude<JsonlAppendFailure, "prefix-rewritten" | "order-conflict"> | undefined {
  const parsed = parseCompleteRecords(bytes);
  return typeof parsed === "string" ? parsed : undefined;
}

function parseCompleteRecords(bytes: Uint8Array): ParsedRecord[] | Exclude<JsonlAppendFailure, "prefix-rewritten" | "order-conflict"> {
  if (exceedsMergeLimits(bytes)) return "limit-exceeded";
  let scan;
  try {
    scan = scanCompleteJsonl(bytes);
  } catch {
    return "malformed-record";
  }
  if (scan.deferredTail.byteLength !== 0) return "incomplete-record";
  let text: string;
  try {
    text = new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return "malformed-record";
  }
  const rawRecords = text.split("\n").slice(0, -1).filter((raw) => (raw.endsWith("\r") ? raw.slice(0, -1) : raw).length > 0);
  if (rawRecords.length !== scan.records.length) return "malformed-record";
  const occurrences = new Map<string, number>();
  return scan.records.map((record, index) => {
    const identity = canonicalJson(record);
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return { key: `${identity}\0${occurrence}`, raw: rawRecords[index]! };
  });
}

function exceedsMergeLimits(bytes: Uint8Array): boolean {
  if (bytes.byteLength > MAX_APPEND_MERGE_BYTES) return true;
  let newlines = 0;
  for (const byte of bytes) {
    if (byte === 0x0a && ++newlines > MAX_APPEND_MERGE_RECORDS) return true;
  }
  return false;
}

function startsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  if (value.byteLength < prefix.byteLength) return false;
  for (let index = 0; index < prefix.byteLength; index += 1) if (value[index] !== prefix[index]) return false;
  return true;
}

function insertSorted(values: string[], value: string): void {
  const index = values.findIndex((candidate) => value < candidate);
  if (index === -1) values.push(value);
  else values.splice(index, 0, value);
}
