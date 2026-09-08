import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { randomKey, sealVaultKeyForDevice } from "@statecase/crypto";

import { runCli, type CliIO } from "../src/bin.js";
import { ConfigStore } from "../src/config.js";

const temporary: string[] = [];
const originalEnvironment = { ...process.env };
const run = promisify(execFile);

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
});

describe("CLI first-use and second-device UAT (AU-001, CR-009, DR-001)", () => {
  it("publishes selected memory and stages only the requested memory or Drop namespace (AD-MEM-007)", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-memory-product-")); temporary.push(root);
    process.env.STATECASE_HOME = join(root, "profile"); process.env.STATECASE_TOKEN = "synthetic-token";
    process.env.STATECASE_RECOVERY_PASSPHRASE = "synthetic recovery phrase";
    const remote = new CliRemote(), output: string[] = [], errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch: remote.fetch };
    expect(await command(io, "--json", "login", "--non-interactive")).toBe(0);
    expect(await command(io, "--json", "vault", "create", "memory-fixture", "--recovery-file", join(root, "recovery.json"))).toBe(0);
    const store = new ConfigStore(), config = await store.loadConfig();
    config.mappings.push({ id: "codex", namespace: "harness:codex:default", name: "Codex", kind: "codex", mode: "consume", path: join(root, "native") });
    await store.saveConfig(config);
    const memory = join(root, "memory"), drop = join(root, "drop"); await mkdir(memory, { mode: 0o700 }); await mkdir(drop, { mode: 0o700 });
    await writeFile(join(memory, "MEMORY.md"), "checkpoint recall", { mode: 0o600 }); await writeFile(join(drop, "brief.md"), "checkpoint brief", { mode: 0o600 });
    expect(await command(io, "--json", "memory", "map", "recall", memory, "--kind", "codex-global", "--harness", "harness:codex:default", "--yes")).toBe(0);
    expect(await command(io, "--json", "drop", "add", drop, "--name", "brief")).toBe(0); const dropId = JSON.parse(output.at(-1)!).id;
    expect(await command(io, "--json", "push")).toBe(0); const revision = JSON.parse(output.at(-1)!).results[0].revisionId;
    await writeFile(join(memory, "MEMORY.md"), "newer recall", { mode: 0o600 }); expect(await command(io, "--json", "push")).toBe(0);
    expect(await command(io, "--json", "memory", "map", "unrelated", join(root, "unrelated"), "--kind", "codex-global", "--harness", "harness:codex:default", "--yes")).toBe(0);
    const before = await readFile(join(store.home, "config.json"));
    const target = join(root, "staged-memory");
    expect(await command(io, "--json", "restore", "--revision", revision, "--mapping", "memory_recall", "--target", target, "--dry-run")).toBe(0);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await command(io, "--json", "restore", "--revision", revision, "--mapping", "memory_recall", "--target", target)).toBe(0);
    expect(await readFile(join(target, "MEMORY.md"), "utf8")).toBe("checkpoint recall");
    await expect(readFile(join(target, "collection.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const stagedDrop = join(root, "staged-drop");
    expect(await command(io, "--json", "restore", "--revision", revision, "--mapping", dropId, "--target", stagedDrop)).toBe(0);
    expect(await readFile(join(stagedDrop, "brief.md"), "utf8")).toBe("checkpoint brief");
    expect(await readFile(join(store.home, "config.json"))).toEqual(before);
    expect(await readFile(join(memory, "MEMORY.md"), "utf8")).toBe("newer recall");
    await expect(readFile(join(root, "unrelated"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("controls only its own native profile through JSON start/stop and safe uninstall (RT-012, RT-014)", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-cli-service-"));
    temporary.push(home);
    process.env.HOME = home;
    process.env.STATECASE_HOME = join(home, "profile");
    const output: string[] = [];
    const errors: string[] = [];
    const calls: string[][] = [];
    let definitionPath = "";
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch,
      serviceRunner: async (_file, args) => {
        calls.push([...args]);
        return { stdout: args.includes("show") ? `${definitionPath}\n`
          : args[0] === "print" ? `\tpath = ${definitionPath}\n` : "" };
      },
    };
    expect(await command(io, "--json", "daemon", "install", "--no-start")).toBe(0);
    definitionPath = JSON.parse(output.at(-1)!).path;
    expect(calls).toHaveLength(0);
    for (const action of ["start", "stop"] as const) {
      expect(await command(io, "--json", "daemon", action)).toBe(0);
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ action, platform: process.platform, requested: true });
    }
    calls.length = 0;
    process.env.STATECASE_HOME = join(home, "other-profile");
    expect(await command(io, "--json", "daemon", "uninstall", "--yes")).not.toBe(0);
    expect(calls).toHaveLength(0);
    expect(errors.at(-1)).toContain("another profile");
    process.env.STATECASE_HOME = join(home, "profile");
    expect(await command(io, "--json", "daemon", "uninstall", "--yes")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ removed: true, stopped: true });
    calls.length = 0;
    expect(await command(io, "--json", "daemon", "uninstall", "--yes")).toBe(0);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ removed: false, stopped: false });
  });

  it("creates, exports, joins, maps, pushes, and pulls a vault without revealing credentials", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-cli-uat-"));
    temporary.push(base);
    const machineA = join(base, "machine-a");
    const machineB = join(base, "machine-b");
    const source = join(base, "source");
    const target = join(base, "target");
    const recovery = join(base, "recovery", "personal.statecase-recovery.json");
    await Promise.all([mkdir(source), mkdir(target)]);
    await writeFile(join(source, "context.txt"), "context from machine A\n");
    const remote = new CliRemote();
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch: remote.fetch };
    process.env.STATECASE_API_URL = "https://remote.test";
    process.env.STATECASE_TOKEN = "injected-token-value";
    process.env.STATECASE_RECOVERY_PASSPHRASE = "correct horse battery staple";

    process.env.STATECASE_HOME = machineA;
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "laptop")).toBe(0);
    const firstDeviceId = (JSON.parse(await readFile(join(machineA, "config.json"), "utf8")) as { deviceId: string }).deviceId;
    expect(firstDeviceId).toMatch(/^dev_[a-f0-9]{32}$/u);
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "laptop renamed")).toBe(0);
    expect((JSON.parse(await readFile(join(machineA, "config.json"), "utf8")) as { deviceId: string }).deviceId).toBe(firstDeviceId);
    expect(await command(io, "--json", "vault", "create", "personal", "--recovery-file", recovery)).toBe(0);
    const created = JSON.parse(output.at(-1)!) as { id: string };
    expect(await command(io, "--json", "vault", "list")).toBe(0);
    expect(await command(io, "--json", "drop", "add", source, "--name", "working-context")).toBe(0);
    const drop = JSON.parse(output.at(-1)!) as { id: string };
    expect(await command(io, "--json", "push")).toBe(0);
    const initialRevisionId = remote.scopedRevisionId!;
    const bootstrapFile = join(base, "bootstrap", "sandbox.token");
    expect(await command(io, "--json", "token", "create", "--namespace", `drop:${drop.id}`, "--actions", "read,append", "--ttl", "15", "--output", bootstrapFile)).toBe(0);
    const capability = (JSON.parse(output.at(-1)!) as { capability: { id: string }; bootstrapFile: string }).capability;
    const bootstrapSecret = (await readFile(bootstrapFile, "utf8")).trim();
    expect(bootstrapSecret).toMatch(/^stc_boot_/u);
    expect((await stat(bootstrapFile)).mode & 0o777).toBe(0o600);
    expect(output.at(-1)).not.toContain(bootstrapSecret);
    expect(await command(io, "--json", "token", "create", "--namespace", `drop:${drop.id}`, "--output", bootstrapFile)).toBe(2);
    expect(remote.capabilities.size).toBe(1);
    expect(await command(io, "--json", "token", "create", "--namespace", `drop:${drop.id}`, "--actions", "append", "--output", join(base, "append-only.token"))).toBe(2);
    expect(remote.capabilities.size).toBe(1);
    expect(await command(io, "--json", "token", "list")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ tokens: [{ id: capability.id }] });
    const sandbox = join(base, "sandbox");
    process.env.STATECASE_HOME = sandbox;
    delete process.env.STATECASE_TOKEN;
    expect(await command(io, "--json", "bootstrap", "--token-file", bootstrapFile, "--non-interactive")).toBe(0);
    const sandboxSecrets = JSON.parse(await readFile(join(sandbox, "credentials.json"), "utf8")) as { token: string; vaultKeys: Record<string, string>; scopedVaults: Record<string, { namespaceKeys: Record<string, unknown> }> };
    expect(sandboxSecrets.token).toBe("scoped-access-token");
    expect(sandboxSecrets.vaultKeys).toEqual({});
    expect(Object.keys(sandboxSecrets.scopedVaults.vlt_test.namespaceKeys)).toEqual([`drop:${drop.id}`]);
    expect(output.join("\n")).not.toContain(bootstrapSecret);
    const sandboxTarget = join(base, "sandbox-target");
    await mkdir(sandboxTarget);
    expect(await command(io, "--json", "drop", "map", drop.id, sandboxTarget, "--name", "working-context", "--mode", "consume")).toBe(0);
    expect(await command(io, "--json", "pull")).toBe(0);
    expect(await readFile(join(sandboxTarget, "context.txt"), "utf8")).toBe("context from machine A\n");
    expect(await command(io, "--json", "drop", "map", drop.id, sandboxTarget, "--name", "working-context", "--mode", "two-way")).toBe(0);
    await writeFile(join(sandboxTarget, "context.txt"), "context updated in sandbox\n");
    expect(await command(io, "--json", "push")).toBe(0);

    process.env.STATECASE_HOME = machineA;
    process.env.STATECASE_TOKEN = "injected-token-value";
    expect(await command(io, "--json", "pull")).toBe(0);
    expect(await readFile(join(source, "context.txt"), "utf8")).toBe("context updated in sandbox\n");
    expect(await command(io, "--json", "token", "revoke", capability.id, "--yes")).toBe(0);
    expect(await command(io, "--json", "workspace", "dependencies")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toEqual({ reports: [], unresolved: 0 });
    expect(await command(io, "--json", "snapshot", "create", "Before second device")).toBe(0);
    const snapshot = JSON.parse(output.at(-1)!) as { id: string };
    expect(await command(io, "--json", "snapshot", "list")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ snapshots: [{ id: snapshot.id, protected: true }] });
    expect(await command(io, "--json", "snapshot", "delete", snapshot.id)).toBe(2);
    expect(await command(io, "--json", "snapshot", "delete", snapshot.id, "--yes")).toBe(0);
    expect(await command(io, "--json", "retention", "plan")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ dryRun: true, candidateObjects: 2, deletedObjects: 0 });
    expect(await command(io, "--json", "retention", "collect")).toBe(2);
    expect(await command(io, "--json", "retention", "collect", "--yes")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ dryRun: false, candidateObjects: 2, deletedObjects: 2 });
    expect(remote.garbageCollectionRuns).toEqual([true, false]);
    const restoreTarget = join(base, "historical-restore");
    expect(await command(io, "--json", "restore", "--revision", initialRevisionId, "--mapping", drop.id, "--target", restoreTarget, "--dry-run")).toBe(0);
    await expect(readFile(join(restoreTarget, "context.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await command(io, "--json", "restore", "--revision", initialRevisionId, "--mapping", drop.id, "--target", restoreTarget)).toBe(0);
    expect(await readFile(join(restoreTarget, "context.txt"), "utf8")).toBe("context from machine A\n");
    expect(await command(io, "--json", "restore", "--revision", initialRevisionId, "--mapping", drop.id, "--target", restoreTarget)).toBe(2);
    expect(await command(io, "--json", "restore", "--revision", initialRevisionId, "--mapping", drop.id, "--target", source)).toBe(2);
    expect(await command(io, "--json", "restore", "--revision", initialRevisionId, "--mapping", drop.id, "--in-place")).toBe(2);
    expect(await command(io, "--json", "restore", "--revision", initialRevisionId, "--mapping", drop.id, "--in-place", "--dry-run")).toBe(0);
    expect(await readFile(join(source, "context.txt"), "utf8")).toBe("context updated in sandbox\n");
    expect(await command(io, "--json", "restore", "--revision", initialRevisionId, "--mapping", drop.id, "--in-place", "--yes")).toBe(0);
    const inPlace = JSON.parse(output.at(-1)!) as { mode: string; protectedSnapshotId: string; emergencySnapshotPath: string; result: { revisionId: string } };
    expect(inPlace).toMatchObject({
      mode: "in-place",
      protectedSnapshotId: expect.stringMatching(/^snp_/u),
      emergencySnapshotPath: expect.stringContaining("/recovery/restore_"),
      result: { revisionId: expect.stringMatching(/^srev_/u) },
    });
    expect(await readFile(join(source, "context.txt"), "utf8")).toBe("context from machine A\n");
    expect(JSON.parse(await readFile(join(inPlace.emergencySnapshotPath, "manifest.json"), "utf8"))).toMatchObject({ version: 1, targetRoot: source });
    expect(await command(io, "--json", "emergency", "rollback", inPlace.emergencySnapshotPath)).toBe(2);
    expect(await command(io, "--json", "emergency", "rollback", inPlace.emergencySnapshotPath, "--yes")).toBe(0);
    expect(await readFile(join(source, "context.txt"), "utf8")).toBe("context updated in sandbox\n");
    expect(await command(io, "--json", "push")).toBe(0);
    expect(await command(io, "--json", "restore", "--revision", initialRevisionId, "--mapping", "missing", "--target", join(base, "missing"))).toBe(2);
    expect(await command(io, "--json", "conflicts", "resolve", "--mapping", drop.id, "--strategy", "local")).toBe(2);
    expect(await command(io, "--json", "conflicts", "resolve", "--mapping", drop.id, "--strategy", "remote", "--yes")).toBe(2);
    expect(await command(io, "--json", "conflicts", "resolve", "--mapping", drop.id, "--strategy", "local", "--yes")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ mappingId: drop.id, strategy: "local", protectedSnapshotId: expect.stringMatching(/^snp_/u) });
    expect(await command(io, "--json", "status")).toBe(0);
    expect(await command(io, "--json", "doctor")).toBe(0);
    expect(await command(io, "--json", "device", "list")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ devices: expect.any(Array) });
    expect(await command(io, "--json", "device", "revoke", "dev_other")).toBe(2);
    expect(await command(io, "--json", "device", "revoke", "dev_other", "--yes")).toBe(0);
    expect(await command(io, "--json", "workspace", "attach", "--path", source, "--id", "ws_test", "--mode", "metadata-only", "--git-fetch", "auto")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ id: "ws_test", mode: "metadata-only", gitFetch: "auto" });
    expect(await command(io, "--json", "workspace", "list")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ workspaces: [{ id: "ws_test", gitFetch: "auto" }] });
    expect(await command(io, "--json", "restore", "--revision", initialRevisionId, "--mapping", "ws_test", "--in-place", "--dry-run")).toBe(2);
    expect(await command(io, "--json", "workspace", "attach", "--path", source, "--id", "ws_bad", "--mode", "metadata-only", "--git-fetch", "sometimes")).toBe(2);

    process.env.STATECASE_HOME = machineB;
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "vps")).toBe(0);
    expect(await command(io, "--json", "vault", "join", created.id, "--recovery-file", recovery)).toBe(0);
    expect(await command(io, "--json", "drop", "map", drop.id, target, "--name", "working-context")).toBe(0);
    expect(await command(io, "--json", "pull")).toBe(0);
    expect(await readFile(join(target, "context.txt"), "utf8")).toBe("context updated in sandbox\n");
    expect(await command(io, "--json", "vault", "select", created.id)).toBe(0);
    expect(await command(io, "--json", "logout")).toBe(0);
    expect(errors.join("\n")).not.toContain("injected-token-value");
    expect(output.join("\n")).not.toContain("injected-token-value");
  });

  it("revokes a device, rotates the selected vault, and recovers through the encrypted keyring kit (CR-009, CR-010, AU-008)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-cli-rotation-"));
    temporary.push(base);
    const machineA = join(base, "machine-a");
    const machineB = join(base, "machine-b");
    const machineC = join(base, "machine-c");
    const machineD = join(base, "machine-d");
    const source = join(base, "source");
    const revokedTarget = join(base, "revoked-target");
    const recoveredTarget = join(base, "recovered-target");
    const peerTarget = join(base, "peer-target");
    const initialRecovery = join(base, "recovery", "initial.json");
    const rotatedRecovery = join(base, "recovery", "rotated.json");
    await Promise.all([mkdir(source), mkdir(revokedTarget), mkdir(recoveredTarget), mkdir(peerTarget)]);
    await writeFile(join(source, "context.txt"), "before rotation\n");
    const remote = new CliRemote();
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch: remote.fetch };
    process.env.STATECASE_API_URL = "https://remote.test";
    process.env.STATECASE_TOKEN = "rotation-token";
    process.env.STATECASE_RECOVERY_PASSPHRASE = "correct horse battery staple";

    process.env.STATECASE_HOME = machineA;
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "active")).toBe(0);
    const activeConfig = JSON.parse(await readFile(join(machineA, "config.json"), "utf8")) as { deviceId: string };
    const activeSecrets = JSON.parse(await readFile(join(machineA, "credentials.json"), "utf8")) as { deviceExchange?: { publicKey: string; privateKey: string } };
    expect(activeSecrets.deviceExchange).toMatchObject({
      publicKey: expect.stringMatching(/^stc_x25519_public_v1\./u),
      privateKey: expect.stringMatching(/^stc_x25519_private_v1\./u),
    });
    expect(remote.devices.get(activeConfig.deviceId)?.publicExchangeKey).toBe(activeSecrets.deviceExchange!.publicKey);
    expect(await command(io, "--json", "vault", "create", "personal", "--recovery-file", initialRecovery)).toBe(0);
    const existingRecoveryBytes = await readFile(initialRecovery);
    expect(await command(io, "--json", "vault", "key", "rotate", "--recovery-file", initialRecovery, "--yes")).not.toBe(0);
    expect(await readFile(initialRecovery)).toEqual(existingRecoveryBytes);
    expect(remote.keyEpoch).toBe(1);
    expect(await command(io, "--json", "drop", "add", source, "--name", "context")).toBe(0);
    const drop = JSON.parse(output.at(-1)!) as { id: string };
    expect(await command(io, "--json", "push")).toBe(0);

    process.env.STATECASE_HOME = machineB;
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "lost")).toBe(0);
    const lostConfig = JSON.parse(await readFile(join(machineB, "config.json"), "utf8")) as { deviceId: string };
    expect(await command(io, "--json", "vault", "join", "vlt_test", "--recovery-file", initialRecovery)).toBe(0);
    expect(await command(io, "--json", "drop", "map", drop.id, revokedTarget, "--name", "context")).toBe(0);
    expect(await command(io, "--json", "pull")).toBe(0);

    process.env.STATECASE_HOME = machineD;
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "active peer")).toBe(0);
    expect(await command(io, "--json", "vault", "join", "vlt_test", "--recovery-file", initialRecovery)).toBe(0);
    expect(await command(io, "--json", "drop", "map", drop.id, peerTarget, "--name", "context")).toBe(0);
    expect(await command(io, "--json", "pull")).toBe(0);

    process.env.STATECASE_HOME = machineA;
    expect(await command(io, "--json", "device", "revoke", lostConfig.deviceId, "--yes")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ revoked: true, keyRotationRequired: true });
    remote.loseNextRotationResponse = true;
    expect(await command(io, "--json", "vault", "key", "rotate", "--recovery-file", rotatedRecovery, "--yes")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ keyEpoch: 2, rotated: true, reconciled: true, recoveryFile: rotatedRecovery });
    expect(await stat(rotatedRecovery)).toMatchObject({ mode: expect.any(Number) });
    expect(remote.keyEpoch).toBe(2);
    expect(remote.keyEnvelopes.has(activeConfig.deviceId)).toBe(true);
    expect(remote.keyEnvelopes.has(lostConfig.deviceId)).toBe(false);
    await writeFile(join(source, "context.txt"), "after rotation\n");
    expect(await command(io, "--json", "push")).toBe(0);

    process.env.STATECASE_HOME = machineD;
    expect(await command(io, "--json", "pull")).toBe(0);
    expect(await readFile(join(peerTarget, "context.txt"), "utf8")).toBe("after rotation\n");

    process.env.STATECASE_HOME = machineB;
    expect(await command(io, "--json", "pull")).not.toBe(0);
    expect(await readFile(join(revokedTarget, "context.txt"), "utf8")).toBe("before rotation\n");

    process.env.STATECASE_HOME = machineC;
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "replacement")).toBe(0);
    expect(await command(io, "--json", "vault", "join", "vlt_test", "--recovery-file", initialRecovery)).toBe(6);
    expect(errors.at(-1)).toContain("recovery kit does not contain the current vault key epoch");
    expect(await command(io, "--json", "vault", "join", "vlt_test", "--recovery-file", rotatedRecovery)).toBe(0);
    expect(await command(io, "--json", "drop", "map", drop.id, recoveredTarget, "--name", "context")).toBe(0);
    expect(await command(io, "--json", "pull")).toBe(0);
    expect(await readFile(join(recoveredTarget, "context.txt"), "utf8")).toBe("after rotation\n");
    const replacementSecrets = JSON.parse(await readFile(join(machineC, "credentials.json"), "utf8")) as {
      vaultKeyrings?: Record<string, { currentEpoch: number; keys: Record<string, string> }>;
    };
    expect(replacementSecrets.vaultKeyrings?.vlt_test).toMatchObject({ currentEpoch: 2, keys: { 1: expect.any(String), 2: expect.any(String) } });
    expect(errors.join("\n")).not.toContain("correct horse battery staple");
  // Real Argon2id recovery/enrollment on four devices is not a 5-second unit test.
  }, 30_000);

  it.each(["committed-unavailable", "precommit-old-read"])("preserves the recovery kit after ambiguous connection loss: %s (CR-010)", async (failure) => {
    const base = await mkdtemp(join(tmpdir(), "statecase-cli-rotation-unknown-"));
    temporary.push(base);
    const home = join(base, "machine");
    const initialRecovery = join(base, "recovery", "initial.json");
    const rotatedRecovery = join(base, "recovery", "rotated.json");
    const remote = new CliRemote();
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch: remote.fetch };
    process.env.STATECASE_API_URL = "https://remote.test";
    process.env.STATECASE_TOKEN = "rotation-token";
    process.env.STATECASE_RECOVERY_PASSPHRASE = "correct horse battery staple";
    process.env.STATECASE_HOME = home;

    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "only device")).toBe(0);
    expect(await command(io, "--json", "vault", "create", "personal", "--recovery-file", initialRecovery)).toBe(0);
    remote.loseNextRotationResponse = failure === "committed-unavailable";
    remote.failRotationReconciliation = failure === "committed-unavailable";
    remote.failNextRotationBeforeCommit = failure === "precommit-old-read";

    expect(await command(io, "--json", "vault", "key", "rotate", "--recovery-file", rotatedRecovery, "--yes")).toBe(7);
    expect(remote.keyEpoch).toBe(failure === "committed-unavailable" ? 2 : 1);
    expect((await stat(rotatedRecovery)).mode & 0o777).toBe(0o600);
    const secrets = JSON.parse(await readFile(join(home, "credentials.json"), "utf8")) as {
      vaultKeyrings: Record<string, { currentEpoch: number }>;
    };
    expect(secrets.vaultKeyrings.vlt_test.currentEpoch).toBe(1);
    expect(errors.at(-1)).toContain("recovery kit preserved");
  });

  it("reconciles a lost rotation response from history even after another rotation has already committed (CR-010)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-cli-superseded-epoch-"));
    temporary.push(base);
    const home = join(base, "owner");
    const remote = new CliRemote();
    const output: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => output.push(value), fetch: remote.fetch };
    process.env.STATECASE_API_URL = "https://remote.test";
    process.env.STATECASE_TOKEN = "superseded-epoch-token";
    process.env.STATECASE_RECOVERY_PASSPHRASE = "correct horse battery staple";
    process.env.STATECASE_HOME = home;
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "owner")).toBe(0);
    expect(await command(io, "--json", "vault", "create", "personal", "--recovery-file", join(base, "kits", "epoch1.json"))).toBe(0);
    const thirdKey = await randomKey();
    remote.loseNextRotationResponse = true;
    remote.beforeLostRotationResponse = async () => {
      // Simulate a second authorized rotation reaching the service before the
      // first writer observes its lost response. This is fixture-only key use.
      const envelopes = await Promise.all([...remote.devices.values()].map(async (device) => ({ deviceId: device.id,
        envelope: await sealVaultKeyForDevice({ vaultId: "vlt_test", deviceId: device.id, keyEpoch: 3,
          vaultKey: thirdKey, recipientPublicKey: device.publicExchangeKey! }),
      })));
      expect((await remote.fetch("https://remote.test/v1/vaults/vlt_test/key-rotations", {
        method: "POST", body: JSON.stringify({ expectedEpoch: 2, newEpoch: 3, envelopes }),
      })).status).toBe(201);
    };
    expect(await command(io, "--json", "vault", "key", "rotate", "--recovery-file", join(base, "kits", "epoch2.json"), "--yes")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ keyEpoch: 2, reconciled: true });
    expect(remote.keyEpoch).toBe(3);
    expect(await command(io, "--json", "pull")).toBe(0);
    const local = JSON.parse(await readFile(join(home, "credentials.json"), "utf8")) as { vaultKeyrings: Record<string, { currentEpoch: number; keys: Record<string, string> }> };
    expect(local.vaultKeyrings.vlt_test.currentEpoch).toBe(3);
    expect(local.vaultKeyrings.vlt_test.keys[3]).toBe(Buffer.from(thirdKey).toString("base64url"));
    expect(output.join("\n")).not.toContain(Buffer.from(thirdKey).toString("base64url"));
  });

  it("catches up after multiple offline rotations and leaves credentials/files untouched on missing or forged history (CR-010)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-cli-offline-epochs-"));
    temporary.push(base);
    const owner = join(base, "owner");
    const peer = join(base, "peer");
    const source = join(base, "source");
    const target = join(base, "target");
    const kit = join(base, "kits", "epoch1.json");
    await Promise.all([mkdir(source), mkdir(target)]);
    await writeFile(join(source, "context.txt"), "epoch one\n");
    const remote = new CliRemote();
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch: remote.fetch };
    process.env.STATECASE_API_URL = "https://remote.test";
    process.env.STATECASE_TOKEN = "offline-epochs-token";
    process.env.STATECASE_RECOVERY_PASSPHRASE = "correct horse battery staple";
    process.env.STATECASE_HOME = owner;
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "owner")).toBe(0);
    expect(await command(io, "--json", "vault", "create", "personal", "--recovery-file", kit)).toBe(0);
    expect(await command(io, "--json", "drop", "add", source, "--name", "context")).toBe(0);
    const drop = JSON.parse(output.at(-1)!) as { id: string };
    expect(await command(io, "--json", "push")).toBe(0);
    process.env.STATECASE_HOME = peer;
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "peer")).toBe(0);
    expect(await command(io, "--json", "vault", "join", "vlt_test", "--recovery-file", kit)).toBe(0);
    expect(await command(io, "--json", "drop", "map", drop.id, target, "--name", "context")).toBe(0);
    expect(await command(io, "--json", "pull")).toBe(0);
    const priorCredentials = await readFile(join(peer, "credentials.json"));
    const peerId = (JSON.parse(await readFile(join(peer, "config.json"), "utf8")) as { deviceId: string }).deviceId;

    process.env.STATECASE_HOME = owner;
    for (const epoch of [2, 3]) {
      expect(await command(io, "--json", "vault", "key", "rotate", "--recovery-file", join(base, "kits", `epoch${epoch}.json`), "--yes")).toBe(0);
      await writeFile(join(source, "context.txt"), `epoch ${epoch}\n`);
      expect(await command(io, "--json", "push")).toBe(0);
    }
    process.env.STATECASE_HOME = peer;
    const second = remote.keyEnvelopeHistory.get(2)!;
    remote.keyEnvelopeHistory.delete(2);
    expect(await command(io, "--json", "pull")).toBe(6);
    expect(await readFile(join(peer, "credentials.json"))).toEqual(priorCredentials);
    expect(await readFile(join(target, "context.txt"), "utf8")).toBe("epoch one\n");
    remote.keyEnvelopeHistory.set(2, second);
    const third = remote.keyEnvelopeHistory.get(3)!;
    const originalEnvelope = third.get(peerId)!;
    third.set(peerId, second.get(peerId)!);
    expect(await command(io, "--json", "pull")).toBe(6);
    expect(await readFile(join(peer, "credentials.json"))).toEqual(priorCredentials);
    expect(await readFile(join(target, "context.txt"), "utf8")).toBe("epoch one\n");
    third.set(peerId, originalEnvelope);
    expect(await command(io, "--json", "pull")).toBe(0);
    expect(await readFile(join(target, "context.txt"), "utf8")).toBe("epoch 3\n");
    const recovered = JSON.parse(await readFile(join(peer, "credentials.json"), "utf8")) as {
      vaultKeyrings: Record<string, { currentEpoch: number; keys: Record<string, string> }>;
    };
    expect(recovered.vaultKeyrings.vlt_test.currentEpoch).toBe(3);
    expect(Object.keys(recovered.vaultKeyrings.vlt_test.keys)).toEqual(["1", "2", "3"]);
  });

  it("drives an approved Git workspace restore through the packaged CLI surface (BK-009, WS-030)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-cli-workspace-restore-"));
    temporary.push(base);
    const home = join(base, "home");
    const root = join(base, "workspace");
    const recovery = join(base, "recovery", "workspace.statecase-recovery.json");
    await mkdir(root);
    await writeFile(join(root, "tracked.txt"), "base\n");
    await run("git", ["-C", root, "init", "-q"]);
    await run("git", ["-C", root, "add", "tracked.txt"]);
    await run("git", ["-C", root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "base"]);
    await run("git", ["-C", root, "branch", "-M", "main"]);
    await writeFile(join(root, "tracked.txt"), "historical index\n");
    await run("git", ["-C", root, "add", "tracked.txt"]);
    await writeFile(join(root, "tracked.txt"), "historical worktree\n");
    await writeFile(join(root, "historical.txt"), "historical\n");

    const remote = new CliRemote();
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch: remote.fetch };
    process.env.STATECASE_HOME = home;
    process.env.STATECASE_API_URL = "https://remote.test";
    process.env.STATECASE_TOKEN = "workspace-token";
    process.env.STATECASE_RECOVERY_PASSPHRASE = "correct horse battery staple";
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "workstation")).toBe(0);
    expect(await command(io, "--json", "vault", "create", "workspace", "--recovery-file", recovery)).toBe(0);
    expect(await command(io, "--json", "workspace", "attach", "--path", root, "--id", "ws_restore", "--git-fetch", "auto")).toBe(0);
    expect(await command(io, "--json", "push")).toBe(0);
    const historicalRevision = remote.scopedRevisionId!;

    await run("git", ["-C", root, "reset", "--hard", "-q", "HEAD"]);
    await writeFile(join(root, "tracked.txt"), "later committed\n");
    await run("git", ["-C", root, "add", "tracked.txt"]);
    await run("git", ["-C", root, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "later"]);
    await writeFile(join(root, "current.txt"), "current only\n");
    expect(await command(io, "--json", "push")).toBe(0);
    expect(await command(io, "--json", "restore", "--revision", historicalRevision, "--mapping", "ws_restore", "--in-place")).toBe(2);
    expect(await command(io, "--json", "restore", "--revision", historicalRevision, "--mapping", "ws_restore", "--in-place", "--dry-run")).toBe(0);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("later committed\n");

    expect(await command(io, "--json", "restore", "--revision", historicalRevision, "--mapping", "ws_restore", "--in-place", "--yes")).toBe(0);
    const restored = JSON.parse(output.at(-1)!) as { emergencySnapshotPath: string; protectedSnapshotId: string };
    expect(restored).toMatchObject({
      emergencySnapshotPath: expect.stringContaining("/recovery/restore_"),
      protectedSnapshotId: expect.stringMatching(/^snp_/u),
    });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("historical worktree\n");
    expect((await run("git", ["-C", root, "show", ":tracked.txt"])).stdout).toBe("historical index\n");
    expect(await readFile(join(root, "historical.txt"), "utf8")).toBe("historical\n");
    await expect(readFile(join(root, "current.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(restored.emergencySnapshotPath, "manifest.json"), "utf8"))).toMatchObject({
      targetRoot: root,
      workspace: { headRef: "refs/heads/main", index: { kind: "file" } },
    });
    expect(errors.join("\n")).not.toContain("workspace-token");
  });

  it("returns stable exit codes for missing authentication and recovery input", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-cli-errors-"));
    temporary.push(home);
    process.env.STATECASE_HOME = home;
    delete process.env.STATECASE_TOKEN;
    delete process.env.STATECASE_RECOVERY_PASSPHRASE;
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch: fetch };
    expect(await command(io, "--json", "push")).toBe(3);
    expect(JSON.parse(errors.at(-1)!)).toMatchObject({ error: { code: 3 } });
    expect(await command(io, "--json", "login", "--non-interactive")).toBe(3);
  });

  it("fails early when Git overlay is requested for a non-Git directory (WS-001)", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-cli-workspace-"));
    const ordinary = join(home, "ordinary");
    temporary.push(home);
    await mkdir(ordinary);
    process.env.STATECASE_HOME = home;
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch };

    expect(await command(io, "--json", "workspace", "attach", "--path", ordinary, "--id", "ws_plain")).toBe(2);
    expect(JSON.parse(errors.at(-1)!)).toMatchObject({ error: { code: 2, message: expect.stringContaining("Git working tree") } });
    expect(await command(io, "--json", "workspace", "attach", "--path", ordinary, "--id", "ws_plain", "--mode", "metadata-only")).toBe(0);
  });

  it("moves and detaches workspace mappings without moving files or retaining stale apply state (ID-011)", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-cli-workspace-lifecycle-"));
    const original = join(home, "original");
    const destination = join(home, "destination");
    const occupied = join(home, "occupied");
    temporary.push(home);
    await Promise.all([mkdir(original), mkdir(destination), mkdir(occupied)]);
    await writeFile(join(original, "local.txt"), "do not move or delete\n");
    await writeFile(join(destination, "destination.txt"), "preserve destination\n");
    process.env.STATECASE_HOME = join(home, "statecase-home");
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch };

    expect(await command(io, "--json", "workspace", "attach", "--id", "ws_main", "--path", original, "--mode", "metadata-only")).toBe(0);
    const configPath = join(process.env.STATECASE_HOME, "config.json");
    const configured = JSON.parse(await readFile(configPath, "utf8")) as { applied: Record<string, unknown> };
    configured.applied["workspace:ws_main"] = { revisionId: "nrev_applied", digests: {} };
    await writeFile(configPath, `${JSON.stringify(configured, null, 2)}\n`);

    expect(await command(io, "--json", "workspace", "move", "ws_main", original)).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ id: "ws_main", moved: false, path: original });
    expect((JSON.parse(await readFile(configPath, "utf8")) as { applied: Record<string, unknown> }).applied["workspace:ws_main"]).toBeDefined();

    expect(await command(io, "--json", "workspace", "move", "ws_main", destination)).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ id: "ws_main", moved: true, previousPath: original, path: destination });
    let moved = JSON.parse(await readFile(configPath, "utf8")) as { workspaces: Array<{ id: string; path: string }>; applied: Record<string, unknown> };
    expect(moved.workspaces).toContainEqual(expect.objectContaining({ id: "ws_main", path: destination }));
    expect(moved.applied["workspace:ws_main"]).toBeUndefined();
    expect(await readFile(join(original, "local.txt"), "utf8")).toBe("do not move or delete\n");
    expect(await readFile(join(destination, "destination.txt"), "utf8")).toBe("preserve destination\n");

    expect(await command(io, "--json", "workspace", "attach", "--id", "ws_other", "--path", occupied, "--mode", "metadata-only")).toBe(0);
    expect(await command(io, "--json", "workspace", "move", "ws_main", occupied)).toBe(2);
    expect(JSON.parse(errors.at(-1)!)).toMatchObject({ error: { code: 2, message: expect.stringContaining("already attached") } });
    moved = JSON.parse(await readFile(configPath, "utf8")) as typeof moved;
    expect(moved.workspaces.find((item) => item.id === "ws_main")?.path).toBe(destination);
    expect(moved.workspaces.find((item) => item.id === "ws_other")?.path).toBe(occupied);

    expect(await command(io, "--json", "workspace", "detach", "ws_main")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ id: "ws_main", detached: true, path: destination });
    const detached = JSON.parse(await readFile(configPath, "utf8")) as typeof moved;
    expect(detached.workspaces.map((item) => item.id)).toEqual(["ws_other"]);
    expect(detached.applied["workspace:ws_main"]).toBeUndefined();
    expect(await readFile(join(destination, "destination.txt"), "utf8")).toBe("preserve destination\n");
    expect(await command(io, "--json", "workspace", "detach", "ws_missing")).toBe(2);
    expect(await command(io, "--json", "workspace", "move", "ws_missing", original)).toBe(2);

    expect(await command(io, "--json", "workspace", "attach", "--id", "ws_rebind", "--path", original, "--mode", "metadata-only")).toBe(0);
    const rebound = JSON.parse(await readFile(configPath, "utf8")) as typeof moved;
    rebound.applied["workspace:ws_rebind"] = { revisionId: "nrev_rebind", digests: {} };
    await writeFile(configPath, `${JSON.stringify(rebound, null, 2)}\n`);
    expect(await command(io, "--json", "workspace", "attach", "--id", "ws_rebind", "--path", original, "--mode", "metadata-only", "--git-fetch", "auto")).toBe(0);
    expect((JSON.parse(await readFile(configPath, "utf8")) as typeof moved).applied["workspace:ws_rebind"]).toBeDefined();
    expect(await command(io, "--json", "workspace", "attach", "--id", "ws_rebind", "--path", destination, "--mode", "metadata-only", "--git-fetch", "auto")).toBe(0);
    const reboundElsewhere = JSON.parse(await readFile(configPath, "utf8")) as typeof moved;
    expect(reboundElsewhere.workspaces.find((item) => item.id === "ws_rebind")?.path).toBe(destination);
    expect(reboundElsewhere.applied["workspace:ws_rebind"]).toBeUndefined();

    const gitCheckout = join(home, "git-checkout");
    const notGit = join(home, "not-git");
    await Promise.all([mkdir(gitCheckout), mkdir(notGit)]);
    await promisify(execFile)("git", ["-C", gitCheckout, "init", "--quiet"]);
    expect(await command(io, "--json", "workspace", "attach", "--id", "ws_git", "--path", gitCheckout)).toBe(0);
    const beforeInvalidMove = await readFile(configPath, "utf8");
    expect(await command(io, "--json", "workspace", "move", "ws_git", notGit)).toBe(2);
    expect(JSON.parse(errors.at(-1)!)).toMatchObject({ error: { code: 2, message: expect.stringContaining("Git working tree") } });
    expect(await readFile(configPath, "utf8")).toBe(beforeInvalidMove);
  });

  it("reports Drop revision alignment and removes only the device-local mapping (DR-003, DR-004)", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-cli-drop-lifecycle-"));
    const source = join(home, "source");
    const destination = join(home, "destination");
    temporary.push(home);
    await Promise.all([mkdir(source), mkdir(destination)]);
    await writeFile(join(source, "context.txt"), "portable context\n");
    await writeFile(join(destination, "existing.txt"), "do not overwrite\n");
    process.env.STATECASE_HOME = join(home, "statecase-home");
    process.env.STATECASE_API_URL = "https://remote.test";
    process.env.STATECASE_TOKEN = "injected-token-value";
    process.env.STATECASE_RECOVERY_PASSPHRASE = "correct horse battery staple";
    const output: string[] = [];
    const errors: string[] = [];
    const remote = new CliRemote();
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch: remote.fetch };

    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "laptop")).toBe(0);
    expect(await command(io, "--json", "vault", "create", "personal", "--recovery-file", join(home, "recovery.json"))).toBe(0);
    expect(await command(io, "--json", "drop", "add", source, "--name", "knowledge", "--mode", "append")).toBe(0);
    const added = JSON.parse(output.at(-1)!) as { id: string };
    expect(await command(io, "--json", "push")).toBe(0);

    expect(await command(io, "--json", "drop", "status", added.id)).toBe(0);
    const current = JSON.parse(output.at(-1)!) as { drops: Array<Record<string, unknown>> };
    expect(current.drops).toEqual([expect.objectContaining({
      id: added.id,
      name: "knowledge",
      mode: "append",
      path: source,
      localState: "ready",
      remoteRelation: "applied",
      appliedRevisionId: expect.stringMatching(/^nrev_/u),
      remoteRevisionId: expect.stringMatching(/^nrev_/u),
    })]);

    const configPath = join(process.env.STATECASE_HOME, "config.json");
    const appliedAtSource = (JSON.parse(await readFile(configPath, "utf8")) as { applied: Record<string, unknown> }).applied[`drop:${added.id}`];
    expect(await command(io, "--json", "drop", "map", added.id, source)).toBe(0);
    const samePath = JSON.parse(await readFile(configPath, "utf8")) as { mappings: Array<{ id: string; name: string; mode: string; path: string }>; applied: Record<string, unknown> };
    expect(samePath.mappings.find((mapping) => mapping.id === added.id)).toMatchObject({ name: "knowledge", mode: "append", path: source });
    expect(samePath.applied[`drop:${added.id}`]).toEqual(appliedAtSource);

    const namespace = `drop:${added.id}`;
    const head = remote.namespaceHeads.get(namespace)!;
    remote.namespaceHeads.set(namespace, { ...head, revisionId: "nrev_remote_advanced" });
    expect(await command(io, "--json", "drop", "status", added.id)).toBe(0);
    expect(JSON.parse(output.at(-1)!).drops).toEqual([expect.objectContaining({
      id: added.id,
      remoteRelation: "remote-ahead",
      remoteRevisionId: "nrev_remote_advanced",
    })]);

    const beforeInvalidMode = await readFile(configPath, "utf8");
    expect(await command(io, "--json", "drop", "map", added.id, source, "--mode", "surprise")).toBe(2);
    expect(await readFile(configPath, "utf8")).toBe(beforeInvalidMode);

    expect(await command(io, "--json", "drop", "map", added.id, destination)).toBe(0);
    const remapped = JSON.parse(await readFile(configPath, "utf8")) as typeof samePath;
    expect(remapped.mappings.find((mapping) => mapping.id === added.id)).toMatchObject({ name: "knowledge", mode: "append", path: destination });
    expect(remapped.applied[namespace]).toBeUndefined();
    expect(await command(io, "--json", "drop", "status", added.id)).toBe(0);
    expect(JSON.parse(output.at(-1)!).drops).toEqual([expect.objectContaining({
      id: added.id,
      path: destination,
      appliedRevisionId: null,
      remoteRelation: "remote-ahead",
    })]);

    const missingPath = join(home, "not-materialized");
    expect(await command(io, "--json", "drop", "map", "drop_missing", missingPath, "--name", "future")).toBe(0);
    expect(await command(io, "--json", "drop", "status", "drop_missing")).toBe(0);
    expect(JSON.parse(output.at(-1)!).drops).toEqual([expect.objectContaining({
      id: "drop_missing",
      localState: "missing",
      appliedRevisionId: null,
      remoteRevisionId: null,
      remoteRelation: "uninitialized",
    })]);
    expect(await command(io, "--json", "drop", "remove", "drop_missing")).toBe(0);

    const configWithVault = JSON.parse(await readFile(configPath, "utf8")) as { selectedVaultId: string };
    const credentialsPath = join(process.env.STATECASE_HOME, "credentials.json");
    const credentials = JSON.parse(await readFile(credentialsPath, "utf8")) as {
      vaultKeys: Record<string, string>;
      scopedVaults?: Record<string, unknown>;
    };
    credentials.vaultKeys = {};
    credentials.scopedVaults = {
      [configWithVault.selectedVaultId]: {
        vaultId: configWithVault.selectedVaultId,
        namespaces: ["drop:some_other_drop"],
        actions: ["read"],
        expiresAt: Date.now() + 60_000,
        namespaceKeys: {},
      },
    };
    await writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`);
    expect(await command(io, "--json", "drop", "status", added.id)).toBe(0);
    expect(JSON.parse(output.at(-1)!).drops).toEqual([expect.objectContaining({
      id: added.id,
      remoteRevisionId: null,
      remoteRelation: "unauthorized",
    })]);

    expect(await command(io, "--json", "drop", "remove", added.id)).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ id: added.id, path: destination, removed: true });
    const removed = JSON.parse(await readFile(configPath, "utf8")) as { mappings: Array<{ id: string }>; applied: Record<string, unknown> };
    expect(removed.mappings.find((mapping) => mapping.id === added.id)).toBeUndefined();
    expect(removed.applied[namespace]).toBeUndefined();
    expect(await readFile(join(source, "context.txt"), "utf8")).toBe("portable context\n");
    expect(await readFile(join(destination, "existing.txt"), "utf8")).toBe("do not overwrite\n");
    expect(remote.namespaceHeads.get(namespace)).toMatchObject({ revisionId: "nrev_remote_advanced" });
    expect(await command(io, "--json", "drop", "status", added.id)).toBe(2);
    expect(await command(io, "--json", "drop", "remove", added.id)).toBe(2);
  });

  it("previews a local Git workspace capsule without persisting or exposing file bytes (WS-033)", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-cli-workspace-capsule-"));
    const checkout = join(home, "checkout");
    const metadataOnly = join(home, "metadata-only");
    temporary.push(home);
    await Promise.all([mkdir(checkout), mkdir(metadataOnly)]);
    await promisify(execFile)("git", ["-C", checkout, "init", "--quiet"]);
    await writeFile(join(checkout, "tracked.txt"), "baseline\n");
    await promisify(execFile)("git", ["-C", checkout, "add", "tracked.txt"]);
    await promisify(execFile)("git", ["-C", checkout, "-c", "user.name=Statecase Test", "-c", "user.email=statecase@example.invalid", "commit", "--quiet", "-m", "baseline"]);
    const baseCommit = (await promisify(execFile)("git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(checkout, "tracked.txt"), "modified-private-marker\n");
    await writeFile(join(checkout, "untracked.txt"), "untracked-private-marker\n");
    process.env.STATECASE_HOME = join(home, "statecase-home");
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = {
      stdout: (value) => output.push(value),
      stderr: (value) => errors.push(value),
      fetch: async () => { throw new Error("workspace capsule preview must stay offline"); },
    };

    expect(await command(io, "--json", "workspace", "attach", "--id", "ws_git", "--path", checkout)).toBe(0);
    const configPath = join(process.env.STATECASE_HOME, "config.json");
    const beforePreview = await readFile(configPath, "utf8");
    expect(await command(io, "--json", "workspace", "capsule", "ws_git")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      workspaceId: "ws_git",
      path: checkout,
      mode: "git-overlay",
      baseCommit,
      recordCount: 2,
      blobCount: 2,
      blobBytes: Buffer.byteLength("modified-private-marker\n") + Buffer.byteLength("untracked-private-marker\n"),
    });
    expect(output.at(-1)).not.toContain("modified-private-marker");
    expect(output.at(-1)).not.toContain("untracked-private-marker");
    expect(await readFile(configPath, "utf8")).toBe(beforePreview);

    expect(await command(io, "--json", "workspace", "attach", "--id", "ws_metadata", "--path", metadataOnly, "--mode", "metadata-only")).toBe(0);
    expect(await command(io, "--json", "workspace", "capsule", "ws_metadata")).toBe(2);
    expect(JSON.parse(errors.at(-1)!)).toMatchObject({ error: { code: 2, message: expect.stringContaining("metadata-only") } });
    expect(await command(io, "--json", "workspace", "capsule", "ws_missing")).toBe(2);
  });

  it("runs an unmodified harness offline and preserves its exit code (RT-002, RT-004, RT-011)", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-cli-run-"));
    temporary.push(home);
    process.env.STATECASE_HOME = home;
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch };

    expect(await command(
      io,
      "run",
      "codex",
      "--executable",
      process.execPath,
      "--sync-interval",
      "0",
      "--",
      "-e",
      "process.exit(19)",
    )).toBe(19);
    expect(errors).toContain("Statecase preflight sync is queued; starting Codex offline.");
    expect(errors).toContain("Statecase final sync is queued and will be retried.");
  });

  it("persists a native session binding created by the supervised final flush (ID-012, RT-004)", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-cli-session-binding-"));
    temporary.push(base);
    const home = join(base, "statecase-home");
    const harness = join(base, "codex-home");
    const workspace = join(base, "workspace");
    const session = join(harness, "sessions", "2026", "09", "07", "supervised.jsonl");
    await Promise.all([mkdir(home), mkdir(join(harness, "sessions", "2026", "09", "07"), { recursive: true }), mkdir(workspace)]);
    await writeFile(join(home, "config.json"), `${JSON.stringify({
      version: 1,
      apiUrl: "https://remote.test",
      deviceId: "dev_supervised",
      selectedVaultId: "vlt_test",
      mappings: [{ id: "harness_codex_default", kind: "codex", mode: "two-way", name: "Codex", namespace: "harness:codex:default", path: harness }],
      workspaces: [{ id: "ws_supervised", path: workspace, sync: "identity-only" }],
      applied: {},
    }, null, 2)}\n`);
    await writeFile(join(home, "credentials.json"), `${JSON.stringify({
      version: 1,
      token: "test-device-token",
      vaultKeys: { vlt_test: Buffer.alloc(32, 7).toString("base64url") },
    }, null, 2)}\n`, { mode: 0o600 });
    process.env.STATECASE_HOME = home;
    process.env.HARNESS_SESSION_PATH = session;
    process.env.HARNESS_WORKSPACE_PATH = workspace;
    const remote = new CliRemote();
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch: remote.fetch };
    const script = "require('node:fs').writeFileSync(process.env.HARNESS_SESSION_PATH, JSON.stringify({type:'session_meta',payload:{cwd:process.env.HARNESS_WORKSPACE_PATH}})+'\\n')";

    expect(await command(io, "run", "codex", "--executable", process.execPath, "--sync-interval", "0", "--", "-e", script)).toBe(0);
    const saved = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as { sessionBindings?: Record<string, string> };
    expect(saved.sessionBindings?.["harness:codex:default\0portable-sessions/ws_supervised/supervised.jsonl"])
      .toBe("sessions/2026/09/07/supervised.jsonl");
    expect(errors).toEqual([]);
  });
});

function command(io: CliIO, ...arguments_: string[]): Promise<number> {
  return runCli(["node", "statecase", ...arguments_], io);
}

class CliRemote {
  readonly objects = new Map<string, Uint8Array>();
  readonly namespaceObjects = new Map<string, Uint8Array>();
  readonly namespaceHeads = new Map<string, { namespace: string; revisionId: string; manifestObjectId: string }>();
  readonly namespaceRevisions = new Map<string, { namespace: string; revisionId: string; manifestObjectId: string; previousRevisionId: string | null }>();
  readonly scopedRevisions = new Map<string, { revisionId: string; previousRevisionId: string | null; namespaces: Array<{ namespace: string; revisionId: string; manifestObjectId: string }> }>();
  readonly vaults: Array<{ id: string; name: string; role: "owner" }> = [];
  revisionId: string | null = null;
  scopedRevisionId: string | null = null;
  manifestObjectId: string | null = null;
  readonly devices = new Map<string, { id: string; name: string; status: "active" | "revoked"; publicExchangeKey?: string }>();
  keyEpoch = 1;
  readonly keyEnvelopes = new Map<string, string>();
  readonly keyEnvelopeHistory = new Map<number, Map<string, string>>();
  readonly homeDevices = new Map<string, string>();
  loseNextRotationResponse = false;
  failNextRotationBeforeCommit = false;
  beforeLostRotationResponse?: () => Promise<void>;
  failRotationReconciliation = false;
  readonly snapshots = new Map<string, { id: string; name: string; revisionId: string; manifestObjectId?: string; protocolVersion?: "1.1"; protected: true; createdAt: number }>();
  readonly revisions = new Map<string, { revisionId: string; manifestObjectId: string; previousRevisionId: string | null }>();
  readonly capabilities = new Map<string, { id: string; vaultId: string; keyEpoch: number; tokenHash: string; namespaces: string[]; actions: Array<"read" | "append">; expiresAt: number; keyEnvelope: string; createdAt: number; redeemedAt?: number; revokedAt?: number }>();
  readonly garbageCollectionRuns: boolean[] = [];

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    if (url.pathname === "/v1/vaults/vlt_test/garbage-collection" && method === "POST") {
      const { dryRun } = JSON.parse(String(init?.body)) as { dryRun: boolean };
      this.garbageCollectionRuns.push(dryRun);
      return Response.json({
        outcome: "completed",
        id: `gc_${this.garbageCollectionRuns.length}`,
        dryRun,
        candidateObjects: 2,
        deletedObjects: dryRun ? 0 : 2,
        deleteBytes: 42,
        checkpoints: 3,
        conservativeScopes: ["legacy"],
        trackedSince: 1,
      });
    }
    const scopedRevision = /^\/v1\/vaults\/vlt_test\/scoped-revisions\/([^/]+)$/u.exec(url.pathname);
    if (scopedRevision) {
      const value = this.scopedRevisions.get(scopedRevision[1]);
      return value ? Response.json(value) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    const namespaceRevision = /^\/v1\/vaults\/vlt_test\/namespaces\/([^/]+)\/revisions\/([^/]+)$/u.exec(url.pathname);
    if (namespaceRevision) {
      const value = this.namespaceRevisions.get(`${decodeURIComponent(namespaceRevision[1])}\0${namespaceRevision[2]}`);
      return value ? Response.json(value) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    const namespaceObject = /^\/v1\/vaults\/vlt_test\/namespaces\/([^/]+)\/objects\/([^/]+)$/u.exec(url.pathname);
    if (namespaceObject) {
      const namespace = decodeURIComponent(namespaceObject[1]);
      const key = `${namespace}\0${namespaceObject[2]}`;
      if (method === "PUT") {
        const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
        this.namespaceObjects.set(key, bytes);
        return Response.json({ created: true, size: bytes.byteLength }, { status: 201 });
      }
      const bytes = this.namespaceObjects.get(key);
      return bytes ? new Response(bytes) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    if (url.pathname.endsWith("/namespaces")) return Response.json({ revisionId: this.scopedRevisionId, namespaces: [...this.namespaceHeads.values()] });
    if (url.pathname.endsWith("/namespace-commits")) {
      const request = JSON.parse(String(init?.body)) as { vaultRevisionId: string; updates: Array<{ namespace: string; keyEpoch?: number; baseNamespaceRevisionId: string | null; namespaceRevisionId: string; manifestObjectId: string }> };
      if (request.updates.some((update) => (update.keyEpoch ?? 1) !== this.keyEpoch)) {
        return Response.json({ error: { code: "KEY_EPOCH_CONFLICT", message: "vault key epoch advanced" } }, { status: 409 });
      }
      for (const update of request.updates) {
        const previousRevisionId = this.namespaceHeads.get(update.namespace)?.revisionId ?? null;
        const head = { namespace: update.namespace, revisionId: update.namespaceRevisionId, manifestObjectId: update.manifestObjectId, keyEpoch: update.keyEpoch ?? 1 };
        this.namespaceHeads.set(update.namespace, head);
        this.namespaceRevisions.set(`${update.namespace}\0${update.namespaceRevisionId}`, { ...head, previousRevisionId });
      }
      const previousRevisionId = this.scopedRevisionId;
      this.scopedRevisionId = request.vaultRevisionId;
      this.scopedRevisions.set(request.vaultRevisionId, { revisionId: request.vaultRevisionId, previousRevisionId, namespaces: [...this.namespaceHeads.values()] });
      return Response.json({ outcome: "committed", revisionId: request.vaultRevisionId });
    }
    if (url.pathname === "/v1/devices/current") {
      const input = JSON.parse(String(init?.body)) as { id: string; name: string; publicExchangeKey?: string };
      const device = { id: input.id, name: input.name, status: "active" as const, publicExchangeKey: input.publicExchangeKey };
      this.devices.set(device.id, device);
      if (process.env.STATECASE_HOME) this.homeDevices.set(process.env.STATECASE_HOME, device.id);
      return Response.json({ accountId: "acct_test", deviceId: device.id, name: device.name });
    }
    if (url.pathname === "/v1/tokens" && method === "POST") {
      const input = JSON.parse(String(init?.body)) as Omit<(typeof this.capabilities extends Map<string, infer T> ? T : never), "createdAt">;
      const record = { ...input, createdAt: Date.now() };
      this.capabilities.set(record.id, record);
      const { tokenHash: _tokenHash, keyEnvelope: _keyEnvelope, ...summary } = record;
      return Response.json(summary, { status: 201 });
    }
    if (url.pathname === "/v1/tokens" && method === "GET") {
      return Response.json({ tokens: [...this.capabilities.values()].map(({ tokenHash: _tokenHash, keyEnvelope: _keyEnvelope, ...record }) => record) });
    }
    const capability = /^\/v1\/tokens\/([^/]+)$/u.exec(url.pathname);
    if (capability && method === "DELETE") {
      const record = this.capabilities.get(capability[1]);
      if (record) record.revokedAt = Date.now();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/bootstrap/redeem" && method === "POST") {
      const { token } = JSON.parse(String(init?.body)) as { token: string };
      const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("base64url");
      const record = [...this.capabilities.values()].find((candidate) => candidate.tokenHash === digest && !candidate.redeemedAt && !candidate.revokedAt);
      if (!record) return Response.json({ error: { code: "AUTH_REQUIRED", message: "invalid" } }, { status: 401 });
      record.redeemedAt = Date.now();
      return Response.json({ accessToken: "scoped-access-token", expiresAt: record.expiresAt, vaultId: record.vaultId, namespaces: record.namespaces, actions: record.actions, keyEnvelope: record.keyEnvelope });
    }
    if (url.pathname === "/v1/devices" && method === "GET") return Response.json({ devices: [...this.devices.values()] });
    const device = /^\/v1\/devices\/([^/]+)$/u.exec(url.pathname);
    if (device && method === "DELETE") {
      const prior = this.devices.get(device[1]);
      this.devices.set(device[1], { id: device[1], name: prior?.name ?? device[1], status: "revoked", publicExchangeKey: prior?.publicExchangeKey });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/vaults" && method === "POST") {
      const vault = { id: "vlt_test", name: "personal", role: "owner" as const };
      this.vaults.push(vault);
      return Response.json(vault, { status: 201 });
    }
    if (url.pathname === "/v1/vaults" && method === "GET") return Response.json({ vaults: this.vaults });
    if (url.pathname === "/v1/vaults/vlt_test/key-recipients" && method === "GET") {
      if (this.failRotationReconciliation && this.keyEpoch > 1) throw new TypeError("simulated reconciliation outage");
      return Response.json({ keyEpoch: this.keyEpoch, devices: [...this.devices.values()]
        .filter((candidate) => candidate.status === "active" && candidate.publicExchangeKey)
        .map((candidate) => ({ id: candidate.id, publicExchangeKey: candidate.publicExchangeKey! }))
        .sort((left, right) => left.id.localeCompare(right.id, "en")) });
    }
    if (url.pathname === "/v1/vaults/vlt_test/key-envelope" && method === "GET") {
      const deviceId = process.env.STATECASE_HOME ? this.homeDevices.get(process.env.STATECASE_HOME) : undefined;
      const current = deviceId ? this.devices.get(deviceId) : undefined;
      return current?.status === "active" && this.keyEnvelopes.has(current.id)
        ? Response.json({ keyEpoch: this.keyEpoch, envelope: this.keyEnvelopes.get(current.id)! })
        : Response.json({ error: { code: "KEY_ENVELOPE_UNAVAILABLE" } }, { status: 409 });
    }
    if (url.pathname === "/v1/vaults/vlt_test/key-envelopes" && method === "GET") {
      const afterEpoch = Number(url.searchParams.get("afterEpoch") ?? "0");
      const deviceId = process.env.STATECASE_HOME ? this.homeDevices.get(process.env.STATECASE_HOME) : undefined;
      const device = deviceId ? this.devices.get(deviceId) : undefined;
      if (device?.status === "revoked") return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
      const envelopes = [...this.keyEnvelopeHistory.entries()]
        .filter(([epoch, values]) => epoch > afterEpoch && Boolean(deviceId && values.has(deviceId)))
        .sort(([left], [right]) => left - right)
        .map(([keyEpoch, values]) => ({ keyEpoch, envelope: values.get(deviceId!)! }));
      return Response.json({ keyEpoch: this.keyEpoch, envelopes });
    }
    if (url.pathname === "/v1/vaults/vlt_test/key-rotations" && method === "POST") {
      if (this.failNextRotationBeforeCommit) {
        this.failNextRotationBeforeCommit = false;
        throw new TypeError("simulated connection loss before mutation becomes visible");
      }
      const input = JSON.parse(String(init?.body)) as { expectedEpoch: number; newEpoch: number; envelopes: Array<{ deviceId: string; envelope: string }> };
      const active = [...this.devices.values()].filter((candidate) => candidate.status === "active" && candidate.publicExchangeKey).map((candidate) => candidate.id).sort();
      const recipients = input.envelopes.map((item) => item.deviceId).sort();
      if (input.expectedEpoch !== this.keyEpoch || input.newEpoch !== this.keyEpoch + 1) {
        return Response.json({ error: { code: "KEY_EPOCH_CONFLICT" } }, { status: 409 });
      }
      if (active.join("\0") !== recipients.join("\0")) return Response.json({ error: { code: "KEY_RECIPIENT_MISMATCH" } }, { status: 409 });
      this.keyEpoch = input.newEpoch;
      this.keyEnvelopes.clear();
      for (const envelope of input.envelopes) this.keyEnvelopes.set(envelope.deviceId, envelope.envelope);
      this.keyEnvelopeHistory.set(this.keyEpoch, new Map(this.keyEnvelopes));
      if (this.loseNextRotationResponse) {
        this.loseNextRotationResponse = false;
        await this.beforeLostRotationResponse?.();
        throw new TypeError("simulated connection loss after committed rotation");
      }
      return Response.json({ keyEpoch: this.keyEpoch, rotated: true }, { status: 201 });
    }
    if (url.pathname.endsWith("/join")) {
      const input = init?.body ? JSON.parse(String(init.body)) as { keyEpoch?: number } : {};
      if ((input.keyEpoch ?? 1) !== this.keyEpoch) return Response.json({ error: { code: "KEY_EPOCH_CONFLICT" } }, { status: 409 });
      return Response.json({ id: "vlt_test", name: "personal", role: "writer" });
    }
    if (url.pathname.endsWith("/head")) return Response.json({ revisionId: this.revisionId, manifestObjectId: this.manifestObjectId });
    const revision = /\/revisions\/([^/]+)$/u.exec(url.pathname);
    if (revision) {
      const value = this.revisions.get(revision[1]);
      return value ? Response.json(value) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    if (url.pathname.endsWith("/snapshots") && method === "POST") {
      const input = JSON.parse(String(init?.body)) as { id: string; name: string };
      const snapshot = this.scopedRevisionId
        ? { id: input.id, name: input.name, revisionId: this.scopedRevisionId, protocolVersion: "1.1" as const, protected: true as const, createdAt: 1 }
        : { id: input.id, name: input.name, revisionId: this.revisionId!, manifestObjectId: this.manifestObjectId!, protected: true as const, createdAt: 1 };
      this.snapshots.set(snapshot.id, snapshot);
      return Response.json(snapshot, { status: 201 });
    }
    if (url.pathname.endsWith("/snapshots") && method === "GET") return Response.json({ snapshots: [...this.snapshots.values()] });
    const snapshot = /^\/v1\/vaults\/vlt_test\/snapshots\/([^/]+)$/u.exec(url.pathname);
    if (snapshot && method === "DELETE") {
      this.snapshots.delete(snapshot[1]);
      return new Response(null, { status: 204 });
    }
    const object = /^\/v1\/vaults\/vlt_test\/objects\/([^/]+)$/u.exec(url.pathname);
    if (object && method === "PUT") {
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      this.objects.set(object[1], bytes);
      return Response.json({ created: true, size: bytes.byteLength }, { status: 201 });
    }
    if (object) return new Response(this.objects.get(object[1]));
    if (url.pathname.endsWith("/commits")) {
      const body = JSON.parse(String(init?.body)) as { revisionId: string; manifestObjectId: string };
      this.revisionId = body.revisionId;
      this.manifestObjectId = body.manifestObjectId;
      this.revisions.set(body.revisionId, { revisionId: body.revisionId, manifestObjectId: body.manifestObjectId, previousRevisionId: null });
      return Response.json({ outcome: "committed", revisionId: body.revisionId });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "not found" } }, { status: 404 });
  };
}
