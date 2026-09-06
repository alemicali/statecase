import { describe, expect, it } from "vitest";

import { AdapterFormatError, scanCompleteJsonl } from "../src/index.js";

describe("append-safe JSONL scan (AD-CX-003..005, AD-CL-003)", () => {
  it("parses complete records and preserves an incomplete tail", () => {
    const input = new TextEncoder().encode('{"id":1}\r\n{"id":2}\n{"id":');
    const result = scanCompleteJsonl(input);
    expect(result.records).toEqual([{ id: 1 }, { id: 2 }]);
    expect(new TextDecoder().decode(result.acceptedPrefix)).toBe('{"id":1}\r\n{"id":2}\n');
    expect(new TextDecoder().decode(result.deferredTail)).toBe('{"id":');
  });

  it("fails closed on malformed complete JSON rather than skipping it", () => {
    expect(() => scanCompleteJsonl(new TextEncoder().encode('{broken}\n'))).toThrowError(
      expect.objectContaining({ code: "MALFORMED_COMPLETE_RECORD" }),
    );
  });

  it("detects an accepted-prefix rewrite", () => {
    const first = scanCompleteJsonl(new TextEncoder().encode('{"id":1}\n'));
    expect(() =>
      scanCompleteJsonl(new TextEncoder().encode('{"id":9}\n'), {
        length: first.acceptedPrefix.byteLength,
        digest: first.acceptedDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "PREFIX_REWRITTEN" }));
  });

  it("accepts an unchanged prefix followed by appended records", () => {
    const firstBytes = new TextEncoder().encode('{"id":1}\n');
    const first = scanCompleteJsonl(firstBytes);
    const next = scanCompleteJsonl(new TextEncoder().encode('{"id":1}\n{"id":2}\n'), {
      length: first.acceptedPrefix.byteLength,
      digest: first.acceptedDigest,
    });
    expect(next.records).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("detects truncation and serializes only a safe error", () => {
    const error = new AdapterFormatError("PREFIX_REWRITTEN", "safe diagnostic");
    expect(error.toJSON()).toEqual({ code: "PREFIX_REWRITTEN", message: "safe diagnostic" });
    expect(() => scanCompleteJsonl(new Uint8Array(), { length: 1, digest: "x" })).toThrowError(
      expect.objectContaining({ code: "PREFIX_REWRITTEN" }),
    );
  });

  it("ignores blank complete records", () => {
    expect(scanCompleteJsonl(new TextEncoder().encode('\n\r\n{"id":1}\n')).records).toEqual([{ id: 1 }]);
  });
});
