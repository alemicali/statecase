import { describe, expect, it, vi } from "vitest";
import { transformPatchPaths } from "../src/index.js";

describe("lossless freeform patch path projection (AD-MEM-011, WS-022)", () => {
  const patch = (lines: string[], eol = "\n") => ["*** Begin Patch", ...lines, "*** End Patch", ""].join(eol);
  it.each(["\n", "\r\n"])("rewrites only validated header paths, preserving all other bytes (%j)", (eol) => {
    const lines = ["*** Add File: new notes.md", "+*** Delete File: keep.md", "+/source/keep.md",
      "*** Update File: old.md", "*** Move to: moved.md", "@@ /source/context.md",
      " *** Add File: context.md", "-*** Delete File: removed-text.md", "+*** Move to: added-text.md",
      "*** End of File", "*** Delete File: deleted.md"];
    const source = patch(lines, eol) + " \t";
    const callback = vi.fn((path: string) => `/target/${path}`);
    const expected = lines.map((line) => line.replace(/^(\*\*\* (?:(?:Add|Update|Delete) File|Move to): )(.+)$/u, "$1/target/$2"));
    expect(transformPatchPaths(source, callback)).toBe(patch(expected, eol) + " \t");
    expect(callback.mock.calls.flat()).toEqual(["new notes.md", "old.md", "moved.md", "deleted.md"]);
    expect(transformPatchPaths(source, (path) => path)).toBe(source);
  });
  it("supports empty patches and empty Add/Update bodies without inventing paths", () => {
    for (const lines of [[], ["*** Add File: empty.md"], ["*** Update File: existing.md"]]) {
      const source = patch(lines);
      expect(transformPatchPaths(source, (path) => path)).toBe(source);
    }
  });
  it.each([
    "", "*** Begin Patch\n*** Add File: x.md\n+x", "leading\n*** Begin Patch\n*** End Patch",
    patch(["*** Add File: valid.md", "+x", "unsupported"]),
    patch(["*** Move to: orphan.md"]), patch(["+orphan"]),
    patch(["*** Delete File: x.md", "+invalid"]), patch(["*** Add File: x.md", "-invalid"]),
    patch(["*** Add File: x.md", "*** Move to: y.md"]),
    patch(["*** Update File: x.md", "*** Unknown"]),
    patch(["*** Update File: x.md", "*** Move to: y.md", "*** Move to: z.md"]),
    patch(["*** Update File: x.md", "@@", "*** Move to: y.md"]),
    patch(["*** Update File: x.md", "*** End of File", "+late"]),
    patch(["*** Add File: bad\u0000.md"]), patch(["*** Add File: bad\r.md"]),
    patch(["*** Update File: x.md", "*** Move to: bad\u0000.md"]),
    patch(["*** Add File: " + "x".repeat(4097)]),
  ])("rejects the whole malformed envelope before invoking the mapper (%#)", (source) => {
    const callback = vi.fn((path: string) => path);
    expect(transformPatchPaths(source, callback)).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
  });
  it.each(["", "bad\n*** Delete File: injected.md", "bad\u007f.md", "x".repeat(4097)])("refuses unsafe mapped headers (%#)", (mapped) => {
    expect(transformPatchPaths(patch(["*** Delete File: original.md"]), () => mapped)).toBeUndefined();
  });
});
