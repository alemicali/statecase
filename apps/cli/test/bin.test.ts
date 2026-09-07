import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIO } from "../src/bin.js";

const temporary: string[] = [];
const originalEnvironment = { ...process.env };

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
});

describe("CLI first-use and second-device UAT (AU-001, CR-009, DR-001)", () => {
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
    const restoreTarget = join(base, "historical-restore");
    expect(await command(io, "--json", "restore", "--revision", initialRevisionId, "--mapping", drop.id, "--target", restoreTarget, "--dry-run")).toBe(0);
    await expect(readFile(join(restoreTarget, "context.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await command(io, "--json", "restore", "--revision", initialRevisionId, "--mapping", drop.id, "--target", restoreTarget)).toBe(0);
    expect(await readFile(join(restoreTarget, "context.txt"), "utf8")).toBe("context from machine A\n");
    expect(await command(io, "--json", "restore", "--revision", initialRevisionId, "--mapping", drop.id, "--target", restoreTarget)).toBe(2);
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
    }, null, 2)}\n`);
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
  readonly devices = new Map<string, { id: string; name: string; status: "active" | "revoked" }>();
  readonly snapshots = new Map<string, { id: string; name: string; revisionId: string; manifestObjectId?: string; protocolVersion?: "1.1"; protected: true; createdAt: number }>();
  readonly revisions = new Map<string, { revisionId: string; manifestObjectId: string; previousRevisionId: string | null }>();
  readonly capabilities = new Map<string, { id: string; vaultId: string; tokenHash: string; namespaces: string[]; actions: Array<"read" | "append">; expiresAt: number; keyEnvelope: string; createdAt: number; redeemedAt?: number; revokedAt?: number }>();

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
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
      const request = JSON.parse(String(init?.body)) as { vaultRevisionId: string; updates: Array<{ namespace: string; baseNamespaceRevisionId: string | null; namespaceRevisionId: string; manifestObjectId: string }> };
      for (const update of request.updates) {
        const previousRevisionId = this.namespaceHeads.get(update.namespace)?.revisionId ?? null;
        const head = { namespace: update.namespace, revisionId: update.namespaceRevisionId, manifestObjectId: update.manifestObjectId };
        this.namespaceHeads.set(update.namespace, head);
        this.namespaceRevisions.set(`${update.namespace}\0${update.namespaceRevisionId}`, { ...head, previousRevisionId });
      }
      const previousRevisionId = this.scopedRevisionId;
      this.scopedRevisionId = request.vaultRevisionId;
      this.scopedRevisions.set(request.vaultRevisionId, { revisionId: request.vaultRevisionId, previousRevisionId, namespaces: [...this.namespaceHeads.values()] });
      return Response.json({ outcome: "committed", revisionId: request.vaultRevisionId });
    }
    if (url.pathname === "/v1/devices/current") {
      const input = JSON.parse(String(init?.body)) as { id: string; name: string };
      const device = { id: input.id, name: input.name, status: "active" as const };
      this.devices.set(device.id, device);
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
      this.devices.set(device[1], { id: device[1], name: device[1], status: "revoked" });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/vaults" && method === "POST") {
      const vault = { id: "vlt_test", name: "personal", role: "owner" as const };
      this.vaults.push(vault);
      return Response.json(vault, { status: 201 });
    }
    if (url.pathname === "/v1/vaults" && method === "GET") return Response.json({ vaults: this.vaults });
    if (url.pathname.endsWith("/join")) return Response.json({ id: "vlt_test", name: "personal", role: "writer" });
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
