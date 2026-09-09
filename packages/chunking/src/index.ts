export type ChunkPolicy =
  | { strategy: "fixed"; size: number }
  | { strategy: "fastcdc"; minSize: number; targetSize: number; maxSize: number };

export interface JsonlChunkResult {
  chunks: Uint8Array[];
  deferredTail: Uint8Array;
}

export interface JsonlStreamPolicy {
  targetSize: number;
  maxSize: number;
}

export function chunkBytes(input: Uint8Array, policy: ChunkPolicy): Uint8Array[] {
  validatePolicy(policy);
  if (input.byteLength === 0) return [];
  return policy.strategy === "fixed" ? fixedChunks(input, policy.size) : fastCdcChunks(input, policy);
}

export function chunkJsonl(input: Uint8Array, targetSize: number): JsonlChunkResult {
  if (!Number.isSafeInteger(targetSize) || targetSize <= 0) throw new RangeError("targetSize must be positive");
  const lastNewline = input.lastIndexOf(0x0a);
  if (lastNewline < 0) return { chunks: [], deferredTail: input.slice() };

  const accepted = input.subarray(0, lastNewline + 1);
  const chunks: Uint8Array[] = [];
  let chunkStart = 0;
  let lineStart = 0;
  for (let index = 0; index < accepted.byteLength; index += 1) {
    if (accepted[index] !== 0x0a) continue;
    const lineEnd = index + 1;
    if (lineStart > chunkStart && lineEnd - chunkStart > targetSize) {
      chunks.push(accepted.slice(chunkStart, lineStart));
      chunkStart = lineStart;
    }
    lineStart = lineEnd;
  }
  if (chunkStart < accepted.byteLength) chunks.push(accepted.slice(chunkStart));
  return { chunks, deferredTail: input.slice(lastNewline + 1) };
}

/**
 * Streams JSONL with stable record-aware boundaries. Records are kept whole
 * where possible; records larger than maxSize are split into bounded chunks.
 * An unterminated final record is emitted so concatenating the output always
 * reconstructs the exact input.
 */
export async function* chunkJsonlStream(
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  policy: JsonlStreamPolicy,
): AsyncGenerator<Uint8Array> {
  validateJsonlStreamPolicy(policy);
  const record = new ByteAccumulator(policy.maxSize);
  let completeRecords: Uint8Array[] = [];
  let completeSize = 0;

  const flushComplete = (): Uint8Array | undefined => {
    if (completeSize === 0) return undefined;
    const output = concatChunks(completeRecords);
    completeRecords = [];
    completeSize = 0;
    return output;
  };

  for await (const input of source) {
    if (!(input instanceof Uint8Array)) throw new TypeError("JSONL stream must yield Uint8Array chunks");
    for (const byte of input) {
      record.push(byte);
      if (record.full && byte !== 0x0a) {
        const complete = flushComplete();
        if (complete) yield complete;
        yield record.take();
        continue;
      }
      if (byte !== 0x0a) continue;

      const completedRecord = record.take();
      if (completeSize > 0 && completeSize + completedRecord.byteLength > policy.targetSize) {
        const complete = flushComplete();
        if (complete) yield complete;
      }
      if (completedRecord.byteLength >= policy.targetSize) {
        yield completedRecord;
      } else {
        completeRecords.push(completedRecord);
        completeSize += completedRecord.byteLength;
      }
    }
  }

  const complete = flushComplete();
  if (complete) yield complete;
  if (record.size > 0) yield record.take();
}

export function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function fixedChunks(input: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < input.byteLength; offset += size) {
    chunks.push(input.slice(offset, Math.min(offset + size, input.byteLength)));
  }
  return chunks;
}

function fastCdcChunks(
  input: Uint8Array,
  policy: Extract<ChunkPolicy, { strategy: "fastcdc" }>,
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  const mask = nextPowerOfTwo(policy.targetSize) - 1;
  let start = 0;
  while (start < input.byteLength) {
    const hardEnd = Math.min(start + policy.maxSize, input.byteLength);
    let end = Math.min(start + policy.minSize, hardEnd);
    let hash = 0;
    while (end < hardEnd) {
      hash = ((hash << 1) + GEAR[input[end]]) >>> 0;
      end += 1;
      if ((hash & mask) === 0) break;
    }
    chunks.push(input.slice(start, end));
    start = end;
  }
  return chunks;
}

function validatePolicy(policy: ChunkPolicy): void {
  if (policy.strategy === "fixed") {
    if (!Number.isSafeInteger(policy.size) || policy.size <= 0) throw new RangeError("fixed size must be positive");
    return;
  }
  const { minSize, targetSize, maxSize } = policy;
  if (
    ![minSize, targetSize, maxSize].every((value) => Number.isSafeInteger(value) && value > 0) ||
    minSize > targetSize ||
    targetSize > maxSize
  ) {
    throw new RangeError("FastCDC sizes must satisfy 0 < min <= target <= max");
  }
}

function validateJsonlStreamPolicy(policy: JsonlStreamPolicy): void {
  if (
    !Number.isSafeInteger(policy.targetSize) ||
    !Number.isSafeInteger(policy.maxSize) ||
    policy.targetSize <= 0 ||
    policy.maxSize < policy.targetSize
  ) {
    throw new RangeError("JSONL stream sizes must satisfy 0 < target <= max");
  }
}

class ByteAccumulator {
  readonly #bytes: Uint8Array;
  #size = 0;

  constructor(capacity: number) {
    this.#bytes = new Uint8Array(capacity);
  }

  get full(): boolean {
    return this.#size === this.#bytes.byteLength;
  }

  get size(): number {
    return this.#size;
  }

  push(byte: number): void {
    this.#bytes[this.#size] = byte;
    this.#size += 1;
  }

  take(): Uint8Array {
    const output = this.#bytes.slice(0, this.#size);
    this.#size = 0;
    return output;
  }
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(value));
}

const GEAR = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = (index + 1) * 0x9e3779b1;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  return value >>> 0;
});
