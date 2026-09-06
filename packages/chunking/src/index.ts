export type ChunkPolicy =
  | { strategy: "fixed"; size: number }
  | { strategy: "fastcdc"; minSize: number; targetSize: number; maxSize: number };

export interface JsonlChunkResult {
  chunks: Uint8Array[];
  deferredTail: Uint8Array;
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
