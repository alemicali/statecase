import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as nativeFile from "../src/native-file.js";
import { createHash } from "node:crypto";
import { scanMemory, prepareMemoryPlan, MEMORY_DESCRIPTOR_PATH } from "../src/memory-sync.js";
import { memoryMappings } from "../src/memory-bindings.js";
import type { LocalConfig } from "../src/config.js";
import type { IncomingNativeText } from "../src/native-text-plan.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "statecase-memory-text-")); roots.push(root);
  const config: LocalConfig = { version: 1, apiUrl: "https://fixture.invalid", applied: {},
    mappings: [{ id: "claude", kind: "claude", namespace: "harness:claude:default", mode: "consume", path: join(root, "claude"), name: "Claude" }],
    workspaces: [{ id: "ws_test", path: join(root, "project"), sync: "identity-only" }],
    memories: [{ id: "mem_test", kind: "claude-project", harnessNamespace: "harness:claude:default", workspaceId: "ws_test", mode: "two-way", path: join(root, "memory") }] };
  return { root, config, mapping: memoryMappings(config)[0]! };
}
const digest = async (_namespace: string, epoch: number, value: Uint8Array) => `${epoch}:${createHash("sha256").update(value).digest("hex")}`;

describe("guarded memory collection transport (AD-MEM-002, AD-MEM-006)", () => {
  it("scans only an explicitly bound collection and authenticates its identity without local paths", async () => {
    const { root, mapping } = await fixture(); await mkdir(join(mapping.path, "topics"), { recursive: true, mode: 0o700 });
    await writeFile(join(mapping.path, "MEMORY.md"), "[topic](topics/project.md)\n", { mode: 0o600 });
    await writeFile(join(mapping.path, "topics", "project.md"), "Synthetic recall\n", { mode: 0o600 });
    const scanned = await scanMemory(mapping);
    expect(scanned.map((entry) => entry.logicalPath)).toEqual([MEMORY_DESCRIPTOR_PATH, "portable-memory/v1/MEMORY.md", "portable-memory/v1/topics/project.md"]);
    const descriptor = JSON.parse(new TextDecoder().decode(scanned[0]!.bytes));
    expect(descriptor).toEqual({ version: 1, kind: "claude-project", harnessNamespace: "harness:claude:default", workspaceId: "ws_test" });
    expect(JSON.stringify(descriptor)).not.toContain(root);
    for (const entry of scanned) { await entry.dispose(); expect(entry.bytes.every((byte) => byte === 0)).toBe(true); }
  });
  it("keeps an absent native directory absent and publishes an explicit empty collection descriptor", async () => {
    const { mapping } = await fixture(); const scanned = await scanMemory(mapping); expect(scanned).toHaveLength(1);
    await expect(readFile(mapping.path)).rejects.toMatchObject({ code: "ENOENT" }); await scanned[0]!.dispose();
  });
  it.each(["unknown", "symlink", "oversize", "unsafe-directory"])("rejects %s native state without arbitrary fallback", async (kind) => {
    const { root, mapping } = await fixture(); await mkdir(mapping.path, { mode: kind === "unsafe-directory" ? 0o777 : 0o700 });
    if (kind === "unsafe-directory") await chmod(mapping.path, 0o777);
    if (kind === "unknown") await writeFile(join(mapping.path, "state.sqlite"), "unknown", { mode: 0o600 });
    if (kind === "symlink") await symlink(root, join(mapping.path, "linked"));
    if (kind === "oversize") await writeFile(join(mapping.path, "MEMORY.md"), Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
    await expect(scanMemory(mapping)).rejects.toThrow();
  });
  it("requires an exact authenticated descriptor before preparing native writes", async () => {
    const { mapping, config } = await fixture(); await mkdir(mapping.path, { mode: 0o700 });
    await writeFile(join(mapping.path, "MEMORY.md"), "current", { mode: 0o600 });
    const scanned = await scanMemory(mapping);
    const incoming = (): IncomingNativeText[] => scanned.map((entry) => ({ mapping, logicalPath: entry.logicalPath, bytes: entry.bytes.slice() }));
    for (const variant of ["missing", "deleted", "workspace", "kind", "extra", "invalid", "duplicate"]) {
      const items = incoming();
      if (variant === "missing") items.shift();
      else if (variant === "deleted") delete (items[0] as { bytes?: Uint8Array }).bytes;
      else if (variant === "duplicate") items.push({ ...items[0]! });
      else {
        const descriptor = JSON.parse(new TextDecoder().decode(items[0]!.bytes));
        if (variant === "workspace") descriptor.workspaceId = "ws_other";
        if (variant === "kind") descriptor.kind = "codex-global";
        if (variant === "extra") descriptor.path = "/private-canary";
        items[0]!.bytes = new TextEncoder().encode(variant === "invalid" ? "invalid" : JSON.stringify(descriptor));
      }
      await expect(prepareMemoryPlan(items, config, () => 1, digest)).rejects.toMatchObject({ code: "MEMORY_IDENTITY_MISMATCH" });
      expect(await readFile(join(mapping.path, "MEMORY.md"), "utf8")).toBe("current"); expect(config.applied).toEqual({});
    }
    for (const entry of scanned) await entry.dispose();
  });
  it("plans edits, conflicts and deletions with current-epoch digests and guarded native paths", async () => {
    const { mapping, config } = await fixture(); await mkdir(mapping.path, { mode: 0o700 });
    await writeFile(join(mapping.path, "MEMORY.md"), "current", { mode: 0o600 });
    const scanned = await scanMemory(mapping);
    const incoming: IncomingNativeText[] = scanned.map((entry) => ({ mapping, logicalPath: entry.logicalPath, bytes: entry.bytes.slice() }));
    incoming[1]!.bytes = new TextEncoder().encode("remote");
    const plan = await prepareMemoryPlan(incoming, config, () => 2, digest);
    expect(plan.writes).toHaveLength(1); expect(plan.writes[0]!.path).toBe(join(mapping.path, "MEMORY.md"));
    expect(plan.conflicts).toEqual(["memory:mem_test:portable-memory/v1/MEMORY.md"]);
    expect(plan.digests).toHaveLength(2); expect(plan.targets).toHaveLength(1);
    await plan.guard(); await writeFile(join(mapping.path, "MEMORY.md"), "concurrent", { mode: 0o600 });
    await expect(plan.guard()).rejects.toMatchObject({ code: "NATIVE_FILE_CHANGED" }); plan.dispose();
    for (const entry of scanned) await entry.dispose();
  });
  it.each(["files", "bytes", "directory"])("bounds %s before returning a partial collection", async (limit) => {
    const { mapping } = await fixture(); await mkdir(mapping.path, { mode: 0o700 });
    const count = limit === "files" ? 257 : limit === "bytes" ? 9 : 4097;
    for (let offset = 0; offset < count; offset += 64) {
      await Promise.all(Array.from({ length: Math.min(64, count - offset) }, (_, index) =>
        writeFile(join(mapping.path, `entry-${offset + index}.md`), limit === "bytes" ? Buffer.alloc(1024 * 1024, 65) : "recall", { mode: 0o600 })));
    }
    await expect(scanMemory(mapping)).rejects.toMatchObject({ code: "MEMORY_FORMAT_UNSUPPORTED" });
  });
  it.each(["disappeared-file", "changed-file", "changed-tree", "disappeared-tree", "enumeration", "stat"])("rejects and redacts a %s failure and wipes retained bytes", async (failure) => {
    const { mapping } = await fixture(); await mkdir(mapping.path, { mode: 0o700 });
    await writeFile(join(mapping.path, "MEMORY.md"), "recall", { mode: 0o600 });
    const readSnapshot = nativeFile.readNativeFileSnapshot;
    let captured: Uint8Array | undefined;
    if (["disappeared-file", "changed-file", "changed-tree", "disappeared-tree"].includes(failure)) {
      vi.spyOn(nativeFile, "readNativeFileSnapshot").mockImplementationOnce(async (...args) => {
        if (failure === "disappeared-file") await rm(join(mapping.path, "MEMORY.md"));
        const snapshot = await readSnapshot(...args); captured = snapshot.bytes;
        if (failure === "changed-file") await writeFile(join(mapping.path, "MEMORY.md"), "changed", { mode: 0o600 });
        if (failure === "changed-tree" || failure === "disappeared-tree") {
          const assert = snapshot.assertUnchanged;
          snapshot.assertUnchanged = async () => {
            await assert();
            if (failure === "changed-tree") await writeFile(join(mapping.path, "new.md"), "new", { mode: 0o600 });
            else await fs.rename(mapping.path, `${mapping.path}-moved`);
          };
        }
        return snapshot;
      });
    }
    if (failure === "enumeration") vi.spyOn(fs, "opendir").mockRejectedValueOnce(new Error("private-host-path"));
    if (failure === "stat") vi.spyOn(fs, "lstat").mockRejectedValueOnce(Object.assign(new Error("private-host-path"), { code: "EACCES" }));
    await expect(scanMemory(mapping)).rejects.toMatchObject({ code: failure === "stat" || failure === "enumeration" ? "NATIVE_FILE_UNSAFE" : "NATIVE_FILE_CHANGED" });
    if (captured) expect(captured.every((byte) => byte === 0)).toBe(true);
  });
  it("rejects absent selection descriptors, oversized descriptors, inconsistent owners and non-memory mappings", async () => {
    const { mapping, config } = await fixture();
    await expect(scanMemory({ ...mapping, memory: undefined })).rejects.toMatchObject({ code: "MEMORY_IDENTITY_MISMATCH" });
    await expect(prepareMemoryPlan([], config, () => 1, digest, [mapping])).rejects.toMatchObject({ code: "MEMORY_IDENTITY_MISMATCH" });
    const scanned = await scanMemory(mapping);
    for (const variant of ["oversized", "owner", "invalid-path"]) {
      const items: IncomingNativeText[] = [{ mapping, logicalPath: MEMORY_DESCRIPTOR_PATH, bytes: scanned[0]!.bytes.slice() }];
      if (variant === "oversized") items[0]!.bytes = new Uint8Array(4097);
      else items.push({ mapping: variant === "owner" ? { ...mapping, memory: { ...mapping.memory!, workspaceId: "ws_other" } } : mapping,
        logicalPath: variant === "owner" ? "portable-memory/v1/MEMORY.md" : "raw-private.txt", bytes: new TextEncoder().encode("recall") });
      await expect(prepareMemoryPlan(items, config, () => 1, digest)).rejects.toMatchObject({ code: variant === "invalid-path" ? "MEMORY_FORMAT_UNSUPPORTED" : "MEMORY_IDENTITY_MISMATCH" });
      expect(items.every((item) => item.bytes!.every((byte) => byte === 0))).toBe(true);
    }
    await scanned[0]!.dispose();
  });
});
