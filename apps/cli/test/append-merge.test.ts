import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { isCompleteJsonlAppend, isCompleteJsonlRecordSupersequence, mergeJsonlAppends } from "../src/append-merge.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);
const records = (value: Uint8Array): Array<{ id: string }> => text(value).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as { id: string });

describe("deterministic complete-record JSONL append merge (SY-004, SY-005)", () => {
  it("converges symmetrically while preserving each branch order", () => {
    const base = bytes('{"id":"base"}\n');
    const remote = bytes('{"id":"base"}\n{"id":"remote-1"}\n{"id":"remote-2"}\n');
    const local = bytes('{"id":"base"}\n{"id":"local-1"}\n{"id":"local-2"}\n');
    const forward = mergeJsonlAppends(base, remote, local);
    const reverse = mergeJsonlAppends(base, local, remote);
    expect(forward.outcome).toBe("merged");
    expect(reverse.outcome).toBe("merged");
    if (forward.outcome !== "merged" || reverse.outcome !== "merged") return;
    expect(forward.bytes).toEqual(reverse.bytes);
    const ids = records(forward.bytes).map((record) => record.id);
    expect(ids[0]).toBe("base");
    expect(ids).toHaveLength(5);
    expect(new Set(ids)).toEqual(new Set(["base", "remote-1", "remote-2", "local-1", "local-2"]));
    expect(ids.indexOf("remote-1")).toBeLessThan(ids.indexOf("remote-2"));
    expect(ids.indexOf("local-1")).toBeLessThan(ids.indexOf("local-2"));
  });

  it("deduplicates the same canonical record occurrence and retains deliberate repeats", () => {
    const base = bytes('{"id":"base"}\n');
    const remote = bytes('{"id":"base"}\n{"kind":"same","id":"shared"}\n{"id":"repeat"}\n{"id":"repeat"}\n');
    const local = bytes('{"id":"base"}\n{"id":"shared","kind":"same"}\n{"id":"local"}\n{"id":"repeat"}\n');
    const result = mergeJsonlAppends(base, remote, local);
    expect(result.outcome).toBe("merged");
    if (result.outcome !== "merged") return;
    const ids = records(result.bytes).map((record) => record.id);
    expect(ids.filter((id) => id === "shared")).toHaveLength(1);
    expect(ids.filter((id) => id === "repeat")).toHaveLength(2);
    expect(ids).toContain("local");
  });

  it("returns the longer branch when the other append is its prefix", () => {
    const base = bytes('{"id":"base"}\n');
    const short = bytes('{"id":"base"}\n{"id":"one"}\n');
    const long = bytes('{"id":"base"}\n{"id":"one"}\n{"id":"two"}\n');
    const result = mergeJsonlAppends(base, short, long);
    expect(result).toMatchObject({ outcome: "merged", appendedRecords: 2 });
    if (result.outcome === "merged") expect(result.bytes).toEqual(long);
  });

  it("accepts empty branches, blank records, and CRLF without inventing records", () => {
    const empty = new Uint8Array();
    expect(mergeJsonlAppends(empty, empty, empty)).toEqual({ outcome: "merged", bytes: empty, appendedRecords: 0 });

    const base = bytes('{"id":"base"}\r\n\r\n');
    const remote = bytes('{"id":"base"}\r\n\r\n{"id":"remote"}\r\n');
    const local = bytes('{"id":"base"}\r\n\r\n{"id":"local"}\r\n');
    const result = mergeJsonlAppends(base, remote, local);
    expect(result.outcome).toBe("merged");
    if (result.outcome !== "merged") return;
    expect(records(result.bytes).map((record) => record.id)).toEqual(["base", "local", "remote"]);
  });

  it("fails closed for rewritten prefixes, incomplete tails, malformed records, and incompatible order", () => {
    const base = bytes('{"id":"base"}\n');
    expect(mergeJsonlAppends(base, bytes('{"id":"rewritten"}\n'), bytes('{"id":"base"}\n{"id":"local"}\n')))
      .toEqual({ outcome: "diverged", reason: "prefix-rewritten" });
    expect(mergeJsonlAppends(base, bytes('{"id":"base"}\n{"id":"tail"'), bytes('{"id":"base"}\n')))
      .toEqual({ outcome: "diverged", reason: "incomplete-record" });
    expect(mergeJsonlAppends(base, bytes('{"id":"base"}\n{broken}\n'), bytes('{"id":"base"}\n')))
      .toEqual({ outcome: "diverged", reason: "malformed-record" });
    const first = bytes('{"id":"base"}\n{"id":"a"}\n{"id":"b"}\n');
    const second = bytes('{"id":"base"}\n{"id":"b"}\n{"id":"a"}\n');
    expect(mergeJsonlAppends(base, first, second)).toEqual({ outcome: "diverged", reason: "order-conflict" });
  });

  it("rejects invalid bases, invalid local suffixes, and non-UTF-8 records", () => {
    const complete = bytes('{"id":"base"}\n');
    expect(mergeJsonlAppends(bytes('{"id":"base"'), complete, complete))
      .toEqual({ outcome: "diverged", reason: "incomplete-record" });
    expect(mergeJsonlAppends(bytes('{broken}\n'), bytes('{broken}\n'), bytes('{broken}\n')))
      .toEqual({ outcome: "diverged", reason: "malformed-record" });
    expect(mergeJsonlAppends(complete, complete, bytes('{"id":"base"}\n{"id":"tail"')))
      .toEqual({ outcome: "diverged", reason: "incomplete-record" });
    expect(mergeJsonlAppends(complete, complete, bytes('{"id":"base"}\n{broken}\n')))
      .toEqual({ outcome: "diverged", reason: "malformed-record" });

    const invalidUtf8 = Uint8Array.from([
      ...bytes('{"id":"'),
      0xff,
      ...bytes('"}\n'),
    ]);
    expect(mergeJsonlAppends(invalidUtf8, invalidUtf8, invalidUtf8))
      .toEqual({ outcome: "diverged", reason: "malformed-record" });
    expect(mergeJsonlAppends(new Uint8Array(), invalidUtf8, new Uint8Array()))
      .toEqual({ outcome: "diverged", reason: "malformed-record" });
  });

  it("recognizes only complete byte-exact forward appends", () => {
    const base = bytes('{"id":"base"}\n');
    expect(isCompleteJsonlAppend(base, bytes('{"id":"base"}\n{"id":"next"}\n'))).toBe(true);
    expect(isCompleteJsonlAppend(base, bytes('{"id":"changed"}\n{"id":"next"}\n'))).toBe(false);
    expect(isCompleteJsonlAppend(base, bytes('{"id":"base"}\n{"id":"tail"'))).toBe(false);
    expect(isCompleteJsonlAppend(bytes('{broken}\n'), bytes('{broken}\n{"id":"next"}\n'))).toBe(false);
  });

  it("recognizes a complete deterministic merge only when every local occurrence remains ordered", () => {
    const local = bytes('{"id":"base"}\n{"id":"local-1"}\n{"id":"repeat"}\n{"id":"repeat"}\n{"id":"local-2"}\n');
    expect(isCompleteJsonlRecordSupersequence(local, bytes('{"id":"base"}\n{"id":"remote"}\n{"id":"local-1"}\n{"id":"repeat"}\n{"id":"repeat"}\n{"id":"local-2"}\n'))).toBe(true);
    expect(isCompleteJsonlRecordSupersequence(local, bytes('{"id":"base"}\n{"id":"local-1"}\n{"id":"repeat"}\n{"id":"local-2"}\n'))).toBe(false);
    expect(isCompleteJsonlRecordSupersequence(local, bytes('{"id":"base"}\n{"id":"local-2"}\n{"id":"local-1"}\n{"id":"repeat"}\n{"id":"repeat"}\n'))).toBe(false);
    expect(isCompleteJsonlRecordSupersequence(local, bytes('{"id":"base"}\n{"id":"local-1"'))).toBe(false);
    expect(isCompleteJsonlRecordSupersequence(local, bytes('{"id":"prepended"}\n{"id":"base"}\n{"id":"local-1"}\n{"id":"repeat"}\n{"id":"repeat"}\n{"id":"local-2"}\n'))).toBe(false);
    expect(isCompleteJsonlRecordSupersequence(new Uint8Array(), new Uint8Array())).toBe(true);
    expect(isCompleteJsonlRecordSupersequence(new Uint8Array(), bytes('{"id":"remote"}\n'))).toBe(true);
  });

  it("converges for randomized disjoint branches and retains both partial orders", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.integer({ min: 0, max: 99 }), { maxLength: 30 }),
      fc.uniqueArray(fc.integer({ min: 100, max: 199 }), { maxLength: 30 }),
      (remoteIds, localIds) => {
        const base = bytes('{"id":"base"}\n');
        const branch = (ids: number[]) => bytes(`{"id":"base"}\n${ids.map((id) => JSON.stringify({ id: String(id) })).join("\n")}${ids.length ? "\n" : ""}`);
        const forward = mergeJsonlAppends(base, branch(remoteIds), branch(localIds));
        const reverse = mergeJsonlAppends(base, branch(localIds), branch(remoteIds));
        expect(forward.outcome).toBe("merged");
        expect(reverse.outcome).toBe("merged");
        if (forward.outcome !== "merged" || reverse.outcome !== "merged") return;
        expect(forward.bytes).toEqual(reverse.bytes);
        const mergedIds = records(forward.bytes).map((record) => record.id);
        expect(isSubsequence(remoteIds.map(String), mergedIds)).toBe(true);
        expect(isSubsequence(localIds.map(String), mergedIds)).toBe(true);
      },
    ), { numRuns: 250 });
  });

  it("fails before graph construction when the complete-record safety limit is exceeded", () => {
    const tooMany = bytes("{}\n".repeat(100_001));
    expect(mergeJsonlAppends(new Uint8Array(), tooMany, new Uint8Array())).toEqual({ outcome: "diverged", reason: "limit-exceeded" });
    expect(isCompleteJsonlRecordSupersequence(tooMany, tooMany)).toBe(false);
  });
});

function isSubsequence(expected: string[], actual: string[]): boolean {
  let index = 0;
  for (const value of actual) if (value === expected[index]) index += 1;
  return index === expected.length;
}
