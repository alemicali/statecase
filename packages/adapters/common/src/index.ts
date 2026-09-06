import { createHash } from "node:crypto";

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
