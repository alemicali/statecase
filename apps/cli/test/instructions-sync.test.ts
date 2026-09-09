import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanInstructions, instructionPath, prepareInstructionPlan } from "../src/instructions-sync.js";
import * as native from "../src/native-file.js";
import type { LocalConfig, RootMapping } from "../src/config.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))); });
async function fixture(kind: RootMapping["kind"] = "claude") {
  const root = await fs.mkdtemp(join(tmpdir(), "statecase-instruction-plan-")); temporary.push(root);
  const mapping: RootMapping = { id: "synthetic", kind, namespace: `harness:${kind}:default`, mode: "two-way", name: "Synthetic", path: root };
  const config = { applied: {} } as LocalConfig;
  return { root, mapping, config };
}
const bytes = (value: string) => new TextEncoder().encode(value);
const digest = async (_namespace: string, epoch: number, value: Uint8Array) => `${epoch}:${createHash("sha256").update(value).digest("hex")}`;
const path = (native: string) => `portable-instructions/v1/${native}`;

describe("instruction scan and materialization boundaries (AD-CTX-003..AD-CTX-006)", () => {
  it("scans only reviewed trees in stable order and wipes retained bytes", async () => {
    const { root, mapping } = await fixture();
    await fs.mkdir(join(root, "rules", "nested"), { recursive: true, mode: 0o700 });
    await fs.mkdir(join(root, "rules", ".hidden"), { mode: 0o700 });
    await fs.writeFile(join(root, "CLAUDE.md"), "@rules/nested/a.md\n", { mode: 0o600 });
    await fs.writeFile(join(root, "rules", "nested", "a.md"), "synthetic\n", { mode: 0o600 });
    await fs.writeFile(join(root, "rules", "ignored.json"), "unreviewed", { mode: 0o600 });
    await fs.writeFile(join(root, "rules", ".hidden", "ignored.md"), "unreviewed", { mode: 0o600 });
    const scanned = await scanInstructions(mapping);
    expect(scanned.map((item) => item.logicalPath)).toEqual([path("CLAUDE.md"), path("rules/nested/a.md")]);
    for (const item of scanned) { expect(item.bytes.some(Boolean)).toBe(true); await item.dispose(); expect(item.bytes.every((value) => value === 0)).toBe(true); }
    expect(await scanInstructions({ ...mapping, kind: "drop" })).toEqual([]);
    expect(instructionPath("drop", path("CLAUDE.md"))).toBeUndefined();
    expect(instructionPath("codex", path("AGENTS.md"))).toBe("AGENTS.md");
  });

  it("rejects symlink trees, linked children and writable tree directories", async () => {
    const { root, mapping } = await fixture(); const outside = join(root, "outside"); await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(outside, join(root, "rules"));
    await expect(scanInstructions(mapping)).rejects.toMatchObject({ code: "NATIVE_FILE_UNSAFE" });
    await fs.unlink(join(root, "rules")); await fs.mkdir(join(root, "rules"), { mode: 0o700 });
    await fs.symlink(outside, join(root, "rules", "linked"));
    await expect(scanInstructions(mapping)).rejects.toMatchObject({ code: "NATIVE_FILE_UNSAFE" });
    await fs.unlink(join(root, "rules", "linked")); await fs.chmod(join(root, "rules"), 0o777);
    await expect(scanInstructions(mapping)).rejects.toMatchObject({ code: "NATIVE_FILE_UNSAFE" });
  });

  it("redacts raw enumeration failures and disposes earlier captures", async () => {
    const { root, mapping } = await fixture(); await fs.mkdir(join(root, "rules"), { mode: 0o700 });
    await fs.writeFile(join(root, "CLAUDE.md"), "synthetic", { mode: 0o600 });
    const observe = native.readNativeFileSnapshot; const captures: native.NativeFileSnapshot[] = [];
    vi.spyOn(native, "readNativeFileSnapshot").mockImplementation(async (...args) => { const value = await observe(...args); captures.push(value); return value; });
    vi.spyOn(fs, "readdir").mockRejectedValue(new Error("raw-private-canary"));
    await expect(scanInstructions(mapping)).rejects.toMatchObject({ code: "NATIVE_FILE_UNSAFE", message: "native context cannot be observed safely" });
    expect(captures.length).toBe(1); expect(captures[0]!.bytes!.every((value) => value === 0)).toBe(true);
  });

  it("detects vanished files and directory mutation during enumeration", async () => {
    const { root, mapping } = await fixture(); await fs.writeFile(join(root, "CLAUDE.md"), "synthetic", { mode: 0o600 });
    const capture = native.readNativeFileSnapshot;
    vi.spyOn(native, "readNativeFileSnapshot").mockImplementationOnce(async (...args) => { await fs.unlink(join(root, "CLAUDE.md")); return capture(...args); });
    await expect(scanInstructions(mapping)).rejects.toMatchObject({ code: "NATIVE_FILE_CHANGED" });
    await fs.mkdir(join(root, "rules"), { mode: 0o700 });
    const enumerate = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementationOnce(async (...args: Parameters<typeof fs.readdir>) => {
      const result = await enumerate(...args); await fs.writeFile(join(root, "rules", "late.md"), "late", { mode: 0o600 }); return result;
    });
    await expect(scanInstructions(mapping)).rejects.toMatchObject({ code: "NATIVE_FILE_CHANGED" });
  });

  it("bounds file count and aggregate bytes before publishing", async () => {
    const { root, mapping } = await fixture(); await fs.mkdir(join(root, "rules"), { mode: 0o700 });
    for (let index = 0; index < 257; index++) await fs.writeFile(join(root, "rules", `${index}.md`), "a", { mode: 0o600 });
    await expect(scanInstructions(mapping)).rejects.toMatchObject({ code: "INSTRUCTION_FORMAT_INVALID" });
    await fs.rm(join(root, "rules"), { recursive: true }); await fs.mkdir(join(root, "rules"), { mode: 0o700 });
    for (let index = 0; index < 9; index++) await fs.writeFile(join(root, "rules", `${index}.md`), Buffer.alloc(1024 * 1024, 97), { mode: 0o600 });
    await expect(scanInstructions(mapping)).rejects.toMatchObject({ code: "INSTRUCTION_FORMAT_INVALID" });
  });

  it("detects a newly created override or instruction tree before accepting a scan", async () => {
    const { root, mapping } = await fixture("codex");
    await fs.writeFile(join(root, "AGENTS.md"), "synthetic", { mode: 0o600 });
    const observe = native.readNativeFileSnapshot;
    vi.spyOn(native, "readNativeFileSnapshot").mockImplementationOnce(async (...args) => {
      const result = await observe(...args);
      return { ...result, async assertUnchanged() { await result.assertUnchanged(); await fs.writeFile(join(root, "AGENTS.override.md"), "new", { mode: 0o600 }); } };
    });
    await expect(scanInstructions(mapping)).rejects.toMatchObject({ code: "NATIVE_FILE_CHANGED" });
    const claude = await fixture(); await fs.writeFile(join(claude.root, "CLAUDE.md"), "synthetic", { mode: 0o600 });
    vi.spyOn(native, "readNativeFileSnapshot").mockImplementationOnce(async (...args) => {
      const result = await observe(...args);
      return { ...result, async assertUnchanged() { await result.assertUnchanged(); await fs.mkdir(join(claude.root, "rules"), { mode: 0o700 }); } };
    });
    await expect(scanInstructions(claude.mapping)).rejects.toMatchObject({ code: "NATIVE_FILE_CHANGED" });
  });

  it("bounds enumeration even when every file is unreviewed", async () => {
    const { root, mapping } = await fixture(); await fs.mkdir(join(root, "rules"), { mode: 0o700 });
    const entry = { name: ".ignored", isSymbolicLink: () => false, isDirectory: () => false };
    vi.spyOn(fs, "readdir").mockResolvedValue(Array.from({ length: 4097 }, () => entry) as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    await expect(scanInstructions(mapping)).rejects.toMatchObject({ code: "INSTRUCTION_FORMAT_INVALID" });
  });

  it("rejects duplicate, conflicting and unreviewed mappings before writes", async () => {
    const { mapping, config } = await fixture();
    const item = { mapping, logicalPath: path("CLAUDE.md"), bytes: bytes("synthetic") };
    for (const incoming of [
      [item, { ...item }],
      [item, { ...item, logicalPath: path("rules/a.md"), mapping: { ...mapping, path: join(mapping.path, "other") } }],
      [item, { ...item, logicalPath: path("rules/a.md"), mapping: { ...mapping, kind: "codex" as const } }],
      [{ ...item, logicalPath: "raw/CLAUDE.md" }],
      [{ ...item, mapping: { ...mapping, kind: "drop" as const } }],
      [item, { ...item, mapping: { ...mapping, namespace: "harness:claude:other" } }],
    ]) await expect(prepareInstructionPlan(incoming, config, () => 2, digest)).rejects.toMatchObject({ code: "INSTRUCTION_FORMAT_INVALID" });
  });

  it("handles noops, local deletions, historical digests and per-path guards", async () => {
    const { root, mapping, config } = await fixture("codex");
    await fs.writeFile(join(root, "AGENTS.md"), "same", { mode: 0o600 });
    const item = { mapping, logicalPath: path("AGENTS.md"), bytes: bytes("same") };
    const unchanged = await prepareInstructionPlan([item, { mapping, logicalPath: path("AGENTS.override.md") }], config, () => 2, digest);
    expect(unchanged.writes).toEqual([]); expect(unchanged.deletes).toEqual([]); await unchanged.guard("unrelated"); await unchanged.guard(); unchanged.dispose();
    config.applied[mapping.namespace] = { revisionId: "nrev_old", keyEpoch: 1, digests: { [path("AGENTS.md")]: await digest(mapping.namespace, 1, bytes("same")) } };
    const remove = await prepareInstructionPlan([{ mapping, logicalPath: path("AGENTS.md") }], config, () => 2, digest);
    expect(remove.conflicts).toEqual([]); expect(remove.deletes).toEqual([join(root, "AGENTS.md")]); remove.dispose();
    await fs.unlink(join(root, "AGENTS.md"));
    const plan = await prepareInstructionPlan([{ ...item, bytes: bytes("remote") }], config, () => 2, digest);
    expect(plan.conflicts).toEqual([`${mapping.namespace}:${item.logicalPath}`]); expect(plan.writes[0]!.mode).toBe(0o600);
    expect(plan.digests[0]!.digest).toBe(await digest(mapping.namespace, 2, bytes("remote")));
    await fs.writeFile(join(root, "AGENTS.md"), "concurrent", { mode: 0o600 });
    await expect(plan.guard(join(root, "AGENTS.md"))).rejects.toMatchObject({ code: "NATIVE_FILE_CHANGED" }); plan.dispose();
    const empty = await prepareInstructionPlan([], config, () => 1, digest); await empty.guard(); empty.dispose(); expect(empty.targets).toEqual([]);
  });
});
