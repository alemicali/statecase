import { describe, expect, it } from "vitest";

import {
  chunkBytes,
  chunkJsonl,
  concatChunks,
  type ChunkPolicy,
} from "../src/index.js";

describe("hybrid chunking (SY-003, AD-CX-003..005)", () => {
  it("returns no chunks for empty input", () => {
    expect(chunkBytes(new Uint8Array(), { strategy: "fixed", size: 4 })).toEqual([]);
  });

  it.each([0, -1, 1.5])("rejects invalid JSONL target %s", (targetSize) => {
    expect(() => chunkJsonl(new Uint8Array(), targetSize)).toThrow("positive");
  });

  it("defers input with no complete JSONL record", () => {
    const input = new TextEncoder().encode('{"partial":true}');
    expect(chunkJsonl(input, 8)).toEqual({ chunks: [], deferredTail: input });
  });
  it("emits only complete JSONL records and returns the incomplete tail", () => {
    const input = new TextEncoder().encode('{"a":1}\n{"b":2}\n{"partial":');
    const result = chunkJsonl(input, 10);
    expect(new TextDecoder().decode(concatChunks(result.chunks))).toBe('{"a":1}\n{"b":2}\n');
    expect(new TextDecoder().decode(result.deferredTail)).toBe('{"partial":');
  });

  it("keeps a single oversized JSONL record intact", () => {
    const input = new TextEncoder().encode(`${"x".repeat(100)}\n`);
    const result = chunkJsonl(input, 8);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toEqual(input);
  });

  it("fixed chunks reconstruct exact bytes", () => {
    const input = Uint8Array.from({ length: 35 }, (_, index) => index);
    const policy: ChunkPolicy = { strategy: "fixed", size: 8 };
    const chunks = chunkBytes(input, policy);
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([8, 8, 8, 8, 3]);
    expect(concatChunks(chunks)).toEqual(input);
  });

  it("content-defined chunks reconstruct and retain most boundaries after insertion", () => {
    const input = Uint8Array.from({ length: 16_384 }, (_, index) => (index * 31) % 251);
    const inserted = new Uint8Array(input.length + 1);
    inserted.set(input.subarray(0, 101), 0);
    inserted[101] = 255;
    inserted.set(input.subarray(101), 102);
    const policy: ChunkPolicy = { strategy: "fastcdc", minSize: 256, targetSize: 512, maxSize: 1024 };
    const before = chunkBytes(input, policy);
    const after = chunkBytes(inserted, policy);
    const beforeBodies = new Set(before.map((chunk) => Buffer.from(chunk).toString("base64")));
    const reused = after.filter((chunk) => beforeBodies.has(Buffer.from(chunk).toString("base64")));

    expect(concatChunks(after)).toEqual(inserted);
    expect(reused.length).toBeGreaterThan(Math.floor(before.length / 2));
  });

  it.each([
    { strategy: "fixed", size: 0 } as ChunkPolicy,
    { strategy: "fixed", size: 1.5 } as ChunkPolicy,
    { strategy: "fastcdc", minSize: 0, targetSize: 2, maxSize: 4 } as ChunkPolicy,
    { strategy: "fastcdc", minSize: 4, targetSize: 2, maxSize: 8 } as ChunkPolicy,
    { strategy: "fastcdc", minSize: 2, targetSize: 9, maxSize: 8 } as ChunkPolicy,
  ])("rejects invalid policy $strategy", (policy) => {
    expect(() => chunkBytes(Uint8Array.of(1), policy)).toThrow();
  });
});
