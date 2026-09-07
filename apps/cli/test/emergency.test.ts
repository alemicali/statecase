import { lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEmergencySnapshot, inspectEmergencySnapshot, restoreEmergencySnapshot } from "../src/emergency.js";

const temporary: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persistent local restore snapshots (BK-009)", () => {
  it("restores replaced, deleted, symlink, and originally absent targets byte-exactly", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-"));
    temporary.push(base);
    const statecaseHome = join(base, "statecase");
    const targetRoot = join(base, "target");
    await mkdir(targetRoot);
    const replaced = join(targetRoot, "replaced.txt");
    const deleted = join(targetRoot, "nested", "deleted.txt");
    const linked = join(targetRoot, "linked");
    const created = join(targetRoot, "created.txt");
    await mkdir(join(targetRoot, "nested"));
    await writeFile(replaced, "before replacement", { mode: 0o640 });
    await writeFile(deleted, "before deletion");
    await symlink("replaced.txt", linked);

    const snapshot = await createEmergencySnapshot({
      id: "restore_test",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome,
      targetRoot,
      paths: [created, deleted, linked, replaced],
    });
    await writeFile(replaced, "after replacement");
    await (await import("node:fs/promises")).rm(deleted);
    await (await import("node:fs/promises")).rm(linked);
    await writeFile(linked, "not a symlink anymore");
    await writeFile(created, "new file");

    await restoreEmergencySnapshot(snapshot.path);

    expect(await readFile(replaced, "utf8")).toBe("before replacement");
    expect((await lstat(replaced)).mode & 0o777).toBe(0o640);
    expect(await readFile(deleted, "utf8")).toBe("before deletion");
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await readlink(linked)).toBe("replaced.txt");
    await expect(readFile(created)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates every backup before mutation and rejects targets outside the selected root", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-tamper-"));
    temporary.push(base);
    const targetRoot = join(base, "target");
    await mkdir(targetRoot);
    const target = join(targetRoot, "value.txt");
    await writeFile(target, "original");
    const snapshot = await createEmergencySnapshot({
      id: "restore_tamper",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot,
      paths: [target],
    });
    const manifest = JSON.parse(await readFile(join(snapshot.path, "manifest.json"), "utf8")) as { records: Array<{ backup?: string }> };
    await writeFile(join(snapshot.path, manifest.records[0]!.backup!), "tampered");
    await writeFile(target, "current must survive");
    await expect(restoreEmergencySnapshot(snapshot.path)).rejects.toThrow("digest");
    expect(await readFile(target, "utf8")).toBe("current must survive");

    await expect(createEmergencySnapshot({
      id: "restore_escape",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot,
      paths: [join(base, "outside.txt")],
    })).rejects.toThrow("outside");
  });

  it("validates snapshot creation boundaries and removes partial snapshots", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-boundaries-"));
    temporary.push(base);
    const targetRoot = join(base, "target");
    const target = join(targetRoot, "value.txt");
    await mkdir(targetRoot);
    await writeFile(target, "value");
    const common = {
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot,
      paths: [target],
    };
    await expect(createEmergencySnapshot({ ...common, id: "../bad" })).rejects.toThrow("ID is invalid");
    await expect(createEmergencySnapshot({ ...common, id: "bad_time", createdAt: "not-a-time" })).rejects.toThrow("timestamp is invalid");
    await expect(createEmergencySnapshot({ ...common, id: "root_path", paths: [targetRoot] })).rejects.toThrow("outside");
    await expect(createEmergencySnapshot({ ...common, id: "nested_home", statecaseHome: join(targetRoot, ".statecase") }))
      .rejects.toThrow("cannot be inside");

    const notDirectory = join(base, "plain-file");
    await writeFile(notDirectory, "plain");
    await expect(createEmergencySnapshot({ ...common, id: "not_directory", targetRoot: notDirectory, paths: [] }))
      .rejects.toThrow("real directory");

    const directoryTarget = join(targetRoot, "directory");
    await mkdir(directoryTarget);
    await expect(createEmergencySnapshot({ ...common, id: "non_regular", paths: [directoryTarget] }))
      .rejects.toThrow("non-regular");
    await expect(lstat(join(common.statecaseHome, "recovery", "non_regular"))).rejects.toMatchObject({ code: "ENOENT" });

    const deduplicated = await createEmergencySnapshot({ ...common, id: "deduplicated", paths: [target, target] });
    expect(deduplicated.records).toBe(1);
    expect(await inspectEmergencySnapshot(deduplicated.path)).toEqual({
      id: "deduplicated",
      targetRoot,
      harness: null,
      records: 1,
    });
  });

  it("rejects malformed manifests and records before touching a target", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-manifests-"));
    temporary.push(base);
    const targetRoot = join(base, "target");
    await mkdir(targetRoot);
    const snapshot = join(base, "snapshot");
    await mkdir(snapshot);
    const manifestPath = join(snapshot, "manifest.json");
    const valid = {
      version: 1,
      id: "valid",
      createdAt: "2026-09-07T18:00:00.000Z",
      targetRoot,
      harness: null,
      records: [],
    };
    const invalidManifests: unknown[] = [
      null,
      [],
      {},
      { ...valid, version: 2 },
      { ...valid, id: 5 },
      { ...valid, createdAt: 5 },
      { ...valid, targetRoot: "relative" },
      { ...valid, records: "no" },
      { ...valid, harness: "other" },
      { ...valid, records: Array.from({ length: 100_001 }, () => ({ path: "x", kind: "absent" })) },
    ];
    for (const value of invalidManifests) {
      await writeFile(manifestPath, JSON.stringify(value));
      await expect(inspectEmergencySnapshot(snapshot)).rejects.toThrow("invalid emergency snapshot manifest");
    }

    const invalidRecords: unknown[] = [
      null,
      [],
      {},
      { path: "", kind: "absent" },
      { path: "../escape", kind: "absent" },
      { path: "bad\\path", kind: "absent" },
      { path: "/absolute", kind: "absent" },
      { path: "x", kind: "symlink", target: "bad\0target" },
      { path: "x", kind: "file", backup: "../escape", digest: "x".repeat(43), size: 0, mode: 0o600 },
      { path: "x", kind: "file", backup: "files/x", digest: "bad", size: 0, mode: 0o600 },
      { path: "x", kind: "file", backup: "files/x", digest: "x".repeat(43), size: -1, mode: 0o600 },
      { path: "x", kind: "file", backup: "files/x", digest: "x".repeat(43), size: 0, mode: 0o1000 },
      { path: "x", kind: "unknown" },
    ];
    for (const record of invalidRecords) {
      await writeFile(manifestPath, JSON.stringify({ ...valid, records: [record] }));
      await expect(restoreEmergencySnapshot(snapshot)).rejects.toThrow("invalid emergency snapshot record");
    }
    await writeFile(manifestPath, JSON.stringify({ ...valid, records: [{ path: "x", kind: "absent" }, { path: "x", kind: "absent" }] }));
    await expect(restoreEmergencySnapshot(snapshot)).rejects.toThrow("invalid emergency snapshot record");
  });

  it("rejects a backup whose type or declared size does not match", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-emergency-backup-"));
    temporary.push(base);
    const targetRoot = join(base, "target");
    await mkdir(targetRoot);
    const target = join(targetRoot, "value.txt");
    await writeFile(target, "original");
    const snapshot = await createEmergencySnapshot({
      id: "backup_types",
      createdAt: "2026-09-07T18:00:00.000Z",
      statecaseHome: join(base, "statecase"),
      targetRoot,
      paths: [target],
      harness: "codex",
    });
    const manifestPath = join(snapshot.path, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { records: Array<{ backup: string; size: number }> };
    manifest.records[0]!.size += 1;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(restoreEmergencySnapshot(snapshot.path)).rejects.toThrow("digest verification");

    manifest.records[0]!.size -= 1;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const backup = join(snapshot.path, manifest.records[0]!.backup);
    const { rm } = await import("node:fs/promises");
    await rm(backup);
    await mkdir(backup);
    await expect(restoreEmergencySnapshot(snapshot.path)).rejects.toThrow("digest verification");
    expect((await inspectEmergencySnapshot(snapshot.path)).harness).toBe("codex");
  });
});
