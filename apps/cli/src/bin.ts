import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { lstat, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveClaudeRoot } from "@statecase/adapter-claude";
import { resolveCodexRoots } from "@statecase/adapter-codex";
import { randomKey } from "@statecase/crypto";
import { workspaceIdForRemote } from "@statecase/domain";
import { LocalStateStore } from "@statecase/storage-local";
import { Command } from "commander";

import { StatecaseClient } from "./client.js";
import { ConfigStore, type LocalConfig, type RootMapping } from "./config.js";
import { PersistentRuntime, readRuntimeStatus, type DaemonTrigger } from "./daemon.js";
import { readRecoveryKit, writeRecoveryKit } from "./recovery.js";
import { DurableReconciler } from "./reconciler.js";
import { exitCodeFor, requireSession, selectedVault, StatecaseUsageError } from "./runtime.js";
import { activateService, installServiceDefinition, removeServiceDefinition, serviceDefinition } from "./service.js";
import { installHarnessShim, removeHarnessShim, verifyHarnessShim } from "./shims.js";
import { installSkill, uninstallSkill, verifySkill } from "./skills.js";
import { HarnessSupervisor, resolveHarnessExecutable, type HarnessName, type ReconcileReason } from "./supervisor.js";
import { SyncConflict, SyncEngine } from "./sync.js";

export interface CliIO {
  stdout(value: string): void;
  stderr(value: string): void;
  fetch: typeof fetch;
}

const defaultIo: CliIO = {
  stdout: (value) => process.stdout.write(`${value}\n`),
  stderr: (value) => process.stderr.write(`${value}\n`),
  fetch,
};

export async function runCli(argv = process.argv, io: CliIO = defaultIo): Promise<number> {
  const store = new ConfigStore();
  const program = new Command();
  let requestedExitCode = 0;
  program.name("statecase").description("Take your agents anywhere.").option("--json", "emit stable JSON output");
  program.enablePositionalOptions();
  program.exitOverride();
  program.configureOutput({ writeOut: (value) => io.stdout(value.trimEnd()), writeErr: (value) => io.stderr(value.trimEnd()) });

  program.command("login")
    .option("--device-name <name>")
    .option("--non-interactive")
    .description("enroll this installation with browser device authorization")
    .action(async (options: { deviceName?: string; nonInteractive?: boolean }) => {
      const config = normalizeConfig(await store.loadConfig());
      const secrets = await store.loadSecrets();
      const injectedToken = process.env.STATECASE_TOKEN;
      let token = injectedToken;
      if (!token) {
        if (options.nonInteractive) throw new StatecaseUsageError("STATECASE_TOKEN is required in non-interactive mode", 3);
        const publicClient = new StatecaseClient(config.apiUrl, undefined, io.fetch);
        const device = await publicClient.startDeviceCode();
        emit(io, program, {
          verificationUri: device.verification_uri_complete ?? `${device.verification_uri}?user_code=${encodeURIComponent(device.user_code)}`,
          userCode: device.user_code,
        }, `Open ${device.verification_uri_complete ?? device.verification_uri} and approve code ${device.user_code}`);
        const deadline = Date.now() + device.expires_in * 1000;
        while (Date.now() < deadline) {
          try {
            token = (await publicClient.pollDeviceCode(device.device_code)).access_token;
            break;
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (code !== "authorization_pending" && code !== "slow_down") throw error;
            await delay((device.interval + (code === "slow_down" ? 5 : 0)) * 1000);
          }
        }
        if (!token) throw new StatecaseUsageError("device authorization expired", 3);
      }
      const deviceName = options.deviceName ?? config.deviceName ?? hostname();
      const deviceId = config.deviceId ?? randomLocalId("dev");
      await new StatecaseClient(config.apiUrl, token, io.fetch).registerDevice({ id: deviceId, name: deviceName });
      config.deviceId = deviceId;
      config.deviceName = deviceName;
      secrets.token = token;
      await Promise.all([store.saveConfig(config), store.saveSecrets(secrets)]);
      emit(io, program, { authenticated: true, deviceName }, `Authenticated as device ${deviceName}`);
    });

  program.command("logout").description("remove the local service session").action(async () => {
    const secrets = await store.loadSecrets();
    delete secrets.token;
    await store.saveSecrets(secrets);
    emit(io, program, { authenticated: false }, "Local session removed");
  });

  const device = program.command("device").description("inspect and revoke enrolled devices");
  device.command("list").action(async () => {
    const { client } = await requireSession(store, io.fetch);
    const devices = await client.listDevices();
    emit(io, program, { devices }, devices.map((item) => `${item.id}\t${item.status}\t${item.name}`).join("\n") || "No devices");
  });
  device.command("revoke <deviceId>").option("--yes", "confirm revocation").action(async (deviceId: string, options: { yes?: boolean }) => {
    if (!options.yes) throw new StatecaseUsageError("device revocation requires --yes", 2);
    const { client } = await requireSession(store, io.fetch);
    await client.revokeDevice(deviceId);
    emit(io, program, { id: deviceId, revoked: true }, `Revoked device ${deviceId}`);
  });

  const vault = program.command("vault").description("manage encrypted vaults");
  vault.command("create <name>").requiredOption("--recovery-file <path>").action(async (name: string, options: { recoveryFile: string }) => {
    const { config, secrets, client } = await requireSession(store, io.fetch);
    const passphrase = requireRecoveryPassphrase();
    const record = await client.createVault(name);
    const key = await randomKey();
    try {
      await writeRecoveryKit(resolve(options.recoveryFile), record.id, key, passphrase);
      secrets.vaultKeys[record.id] = Buffer.from(key).toString("base64url");
      config.selectedVaultId = record.id;
      await Promise.all([store.saveConfig(config), store.saveSecrets(secrets)]);
    } finally {
      key.fill(0);
    }
    emit(io, program, { ...record, recoveryFile: resolve(options.recoveryFile) }, `Created and selected ${record.name ?? record.id}; recovery kit written to ${resolve(options.recoveryFile)}`);
  });
  vault.command("list").action(async () => {
    const { client } = await requireSession(store, io.fetch);
    const records = await client.listVaults();
    emit(io, program, { vaults: records }, records.map((item) => `${item.id}\t${item.role ?? "not joined"}\t${item.name ?? ""}`).join("\n") || "No vaults");
  });
  vault.command("select <vaultId>").action(async (vaultId: string) => {
    const config = normalizeConfig(await store.loadConfig());
    const secrets = await store.loadSecrets();
    if (!secrets.vaultKeys[vaultId]) throw new StatecaseUsageError("vault key is not available on this device", 2);
    config.selectedVaultId = vaultId;
    await store.saveConfig(config);
    emit(io, program, { selectedVaultId: vaultId }, `Selected ${vaultId}`);
  });
  vault.command("join <vaultId>").requiredOption("--recovery-file <path>").action(async (vaultId: string, options: { recoveryFile: string }) => {
    const { config, secrets, client } = await requireSession(store, io.fetch);
    const key = await readRecoveryKit(resolve(options.recoveryFile), vaultId, requireRecoveryPassphrase());
    try {
      const record = await client.joinVault(vaultId);
      secrets.vaultKeys[vaultId] = Buffer.from(key).toString("base64url");
      config.selectedVaultId = vaultId;
      await Promise.all([store.saveConfig(config), store.saveSecrets(secrets)]);
      emit(io, program, record, `Joined and selected ${record.name ?? record.id}`);
    } finally {
      key.fill(0);
    }
  });

  const snapshot = program.command("snapshot").description("protect and inspect retained vault revisions");
  snapshot.command("create <name>").action(async (name: string) => {
    const { config, secrets, client } = await requireSession(store, io.fetch);
    const vaultId = selectedVault(config, secrets);
    const created = await client.createSnapshot(vaultId, name);
    emit(io, program, created, `Protected snapshot ${created.name} (${created.id}) at ${created.revisionId}`);
  });
  snapshot.command("list").action(async () => {
    const { config, secrets, client } = await requireSession(store, io.fetch);
    const vaultId = selectedVault(config, secrets);
    const snapshots = await client.listSnapshots(vaultId);
    emit(io, program, { snapshots }, snapshots.map((item) => `${item.id}\t${item.revisionId}\t${item.name}`).join("\n") || "No snapshots");
  });
  snapshot.command("delete <snapshotId>").option("--yes", "confirm protected snapshot deletion").action(async (snapshotId: string, options: { yes?: boolean }) => {
    if (!options.yes) throw new StatecaseUsageError("protected snapshot deletion requires --yes", 2);
    const { config, secrets, client } = await requireSession(store, io.fetch);
    const vaultId = selectedVault(config, secrets);
    await client.deleteSnapshot(vaultId, snapshotId);
    emit(io, program, { id: snapshotId, deleted: true }, `Deleted protected snapshot ${snapshotId}`);
  });

  program.command("restore")
    .description("materialize one namespace from an immutable historical revision into a staging target")
    .requiredOption("--revision <revisionId>")
    .requiredOption("--mapping <mappingId>", "Drop/harness mapping ID or workspace ID")
    .requiredOption("--target <path>")
    .option("--dry-run")
    .option("--yes", "allow a non-empty target; normal conflict checks still apply")
    .action(async (options: { revision: string; mapping: string; target: string; dryRun?: boolean; yes?: boolean }) => {
      const { config, secrets, client } = await requireSession(store, io.fetch);
      const vaultId = selectedVault(config, secrets);
      const mapping = config.mappings.find((item) => item.id === options.mapping);
      const workspace = config.workspaces.find((item) => item.id === options.mapping);
      if (!mapping && !workspace) throw new StatecaseUsageError("restore mapping is not configured on this device", 2);
      if (mapping && workspace) throw new StatecaseUsageError("restore mapping ID is ambiguous", 2);
      const target = resolve(options.target);
      const targetInfo = await lstat(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (targetInfo && !targetInfo.isDirectory()) throw new StatecaseUsageError("restore target must be a directory", 2);
      if (targetInfo && (await readdir(target)).length > 0 && !options.yes) {
        throw new StatecaseUsageError("non-empty restore target requires --yes", 2);
      }
      const restoreConfig = structuredClone(config);
      restoreConfig.applied = {};
      if (mapping) {
        restoreConfig.mappings = [{ ...mapping, mode: "consume", path: target }];
        restoreConfig.workspaces = restoreConfig.workspaces.map((item) => ({ ...item, sync: "identity-only" }));
      } else {
        restoreConfig.mappings = [];
        restoreConfig.workspaces = [{ ...workspace!, path: target, sync: "git" }];
      }
      const key = Buffer.from(secrets.vaultKeys[vaultId], "base64url");
      try {
        const result = await new SyncEngine(client, vaultId, key).pull(restoreConfig, options.dryRun, options.revision);
        emit(io, program, { revisionId: options.revision, mappingId: options.mapping, target, dryRun: Boolean(options.dryRun), result },
          `${options.dryRun ? "Would restore" : "Restored"} ${result.files} files from ${options.revision} to ${target}`);
      } finally {
        key.fill(0);
      }
    });

  const conflicts = program.command("conflicts").description("resolve explicit concurrent-change conflicts");
  conflicts.command("resolve")
    .requiredOption("--mapping <mappingId>", "Drop/harness mapping ID or workspace ID")
    .requiredOption("--strategy <strategy>", "local")
    .option("--yes", "confirm that local state may supersede the remote namespace")
    .action(async (options: { mapping: string; strategy: string; yes?: boolean }) => {
      if (options.strategy !== "local") throw new StatecaseUsageError("the implemented conflict strategy is local; use restore to inspect the remote variant", 2);
      if (!options.yes) throw new StatecaseUsageError("local conflict resolution requires --yes", 2);
      const { config, secrets, client } = await requireSession(store, io.fetch);
      const vaultId = selectedVault(config, secrets);
      const mapping = config.mappings.find((item) => item.id === options.mapping);
      const workspace = config.workspaces.find((item) => item.id === options.mapping);
      if (!mapping && !workspace) throw new StatecaseUsageError("conflict mapping is not configured on this device", 2);
      if (mapping && workspace) throw new StatecaseUsageError("conflict mapping ID is ambiguous", 2);
      const namespace = mapping?.namespace ?? `workspace:${workspace!.id}`;
      const snapshot = await client.createSnapshot(vaultId, `Before local resolution of ${options.mapping}`);
      const resolveConfig = structuredClone(config);
      if (mapping) {
        resolveConfig.mappings = [mapping];
        resolveConfig.workspaces = resolveConfig.workspaces.map((item) => ({ ...item, sync: "identity-only" }));
      } else {
        resolveConfig.mappings = [];
        resolveConfig.workspaces = [workspace!];
      }
      const key = Buffer.from(secrets.vaultKeys[vaultId], "base64url");
      try {
        const result = await new SyncEngine(client, vaultId, key).push(resolveConfig, false, {
          resolveLocalNamespaces: new Set([namespace]),
          expectedHeadRevisionId: snapshot.revisionId,
        });
        if (resolveConfig.applied[namespace]) config.applied[namespace] = resolveConfig.applied[namespace];
        await store.saveConfig(config);
        emit(io, program, {
          mappingId: options.mapping,
          strategy: "local",
          protectedSnapshotId: snapshot.id,
          previousRevisionId: snapshot.revisionId,
          result,
        }, `Resolved ${options.mapping} with local state; protected previous head as ${snapshot.id}`);
      } finally {
        key.fill(0);
      }
    });

  const drop = program.command("drop").description("map arbitrary synchronized directories");
  drop.command("add <path>").requiredOption("--name <name>").option("--mode <mode>", "two-way, publish, consume, or append", "two-way").action(async (path: string, options: { name: string; mode: RootMapping["mode"] }) => {
    if (!new Set(["two-way", "publish", "consume", "append"]).has(options.mode)) throw new StatecaseUsageError("invalid Drop mode", 2);
    const config = normalizeConfig(await store.loadConfig());
    const id = randomLocalId("drop");
    config.mappings.push({ id, kind: "drop", mode: options.mode, name: options.name, namespace: `drop:${id}`, path: resolve(path) });
    await store.saveConfig(config);
    emit(io, program, { id, name: options.name, path: resolve(path), mode: options.mode }, `Added Drop ${options.name} (${id})`);
  });
  drop.command("map <dropId> <path>").option("--name <name>").option("--mode <mode>", "mapping mode", "two-way").action(async (dropId: string, path: string, options: { name?: string; mode: RootMapping["mode"] }) => {
    const config = normalizeConfig(await store.loadConfig());
    config.mappings = config.mappings.filter((item) => item.id !== dropId);
    config.mappings.push({ id: dropId, kind: "drop", mode: options.mode, name: options.name ?? dropId, namespace: `drop:${dropId}`, path: resolve(path) });
    await store.saveConfig(config);
    emit(io, program, { id: dropId, path: resolve(path), mode: options.mode }, `Mapped ${dropId} to ${resolve(path)}`);
  });
  drop.command("list").action(async () => {
    const mappings = normalizeConfig(await store.loadConfig()).mappings.filter((item) => item.kind === "drop");
    emit(io, program, { drops: mappings }, mappings.map((item) => `${item.id}\t${item.mode}\t${item.path}`).join("\n") || "No Drops");
  });

  const workspace = program.command("workspace").description("map logical projects independently of absolute paths");
  workspace.command("attach")
    .option("--path <path>", "local checkout", process.cwd())
    .option("--id <workspaceId>")
    .option("--auto", "derive identity from the Git origin")
    .option("--name <name>")
    .option("--mode <mode>", "git-overlay or metadata-only", "git-overlay")
    .action(async (options: { path: string; id?: string; auto?: boolean; name?: string; mode: string }) => {
      const path = resolve(options.path);
      if (options.mode !== "git-overlay" && options.mode !== "metadata-only") {
        throw new StatecaseUsageError("workspace mode must be git-overlay or metadata-only", 2);
      }
      if (options.mode === "git-overlay") {
        const inside = await promisify(execFile)("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" })
          .then(({ stdout }) => stdout.trim() === "true", () => false);
        if (!inside) throw new StatecaseUsageError("git-overlay requires a Git working tree; use --mode metadata-only for identity mapping", 2);
      }
      let id = options.id;
      if (!id && options.auto) {
        const { stdout } = await promisify(execFile)("git", ["-C", path, "config", "--get", "remote.origin.url"])
          .catch(() => { throw new StatecaseUsageError("--auto requires a Git origin; provide --id explicitly", 2); });
        id = workspaceIdForRemote(stdout.trim());
      }
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) throw new StatecaseUsageError("provide --id or use --auto in a Git checkout", 2);
      const config = normalizeConfig(await store.loadConfig());
      config.workspaces = config.workspaces.filter((item) => item.id !== id && resolve(item.path) !== path);
      config.workspaces.push({ id, path, sync: options.mode === "metadata-only" ? "identity-only" : "git", ...(options.name ? { name: options.name } : {}) });
      await store.saveConfig(config);
      emit(io, program, { id, path, mode: options.mode }, `Attached ${id} to ${path} (${options.mode})`);
    });
  workspace.command("list").action(async () => {
    const workspaces = normalizeConfig(await store.loadConfig()).workspaces;
    emit(io, program, { workspaces }, workspaces.map((item) => `${item.id}\t${item.sync === "identity-only" ? "metadata-only" : "git-overlay"}\t${item.path}`).join("\n") || "No workspaces");
  });

  program.command("setup")
    .requiredOption("--harness <names>", "codex, claude, or comma-separated values")
    .option("--transparent", "install safe harness shims")
    .option("--shim-dir <path>", "directory that will contain transparent shims")
    .action(async (options: { harness: string; transparent?: boolean; shimDir?: string }) => {
    const config = normalizeConfig(await store.loadConfig());
    const names = new Set(options.harness.split(",").map((name) => name.trim()));
    const additions: RootMapping[] = [];
    if (names.has("codex")) {
      const roots = resolveCodexRoots({ home: homedir(), env: process.env });
      additions.push({ id: "harness_codex_default", kind: "codex", mode: "two-way", name: "Codex", namespace: "harness:codex:default", path: roots.codexHome });
    }
    if (names.has("claude")) {
      additions.push({ id: "harness_claude_default", kind: "claude", mode: "two-way", name: "Claude", namespace: "harness:claude:default", path: resolveClaudeRoot({ home: homedir(), env: process.env }) });
    }
    if (additions.length === 0 || [...names].some((name) => name !== "codex" && name !== "claude")) throw new StatecaseUsageError("supported harnesses are codex and claude", 2);
    for (const addition of additions) {
      config.mappings = config.mappings.filter((item) => item.id !== addition.id);
      config.mappings.push(addition);
    }
    const shims: Array<{ harness: HarnessName; shimPath: string; realExecutable: string }> = [];
    if (options.transparent) {
      const shimDir = resolve(options.shimDir ?? join(store.home, "bin"));
      config.runtime!.shimDir = shimDir;
      for (const harness of [...names] as HarnessName[]) {
        const shimPath = join(shimDir, harness);
        const recorded = config.runtime!.harnesses[harness]?.realExecutable;
        const realExecutable = recorded ?? await resolveHarnessExecutable(harness, process.env, [shimPath, argv[1] ?? ""]);
        await installHarnessShim({ harness, shimPath, statecaseExecutable: resolve(argv[1] ?? "statecase"), realExecutable });
        config.runtime!.harnesses[harness] = { realExecutable, shimPath };
        shims.push({ harness, shimPath, realExecutable });
      }
    }
    const skillTargets = await installSkill();
    await store.saveConfig(config);
    const pathHint = shims.length > 0 ? `; add ${config.runtime!.shimDir} before the harness binaries in PATH` : "";
    emit(io, program, { mappings: additions, skillTargets, shims, pathPrepend: config.runtime!.shimDir ?? null }, `Configured ${additions.map((item) => item.name).join(" and ")} and installed the Statecase skill${pathHint}`);
  });

  program.command("run")
    .description("run an unmodified harness with preflight, periodic, and final synchronization")
    .argument("<harness>", "codex or claude")
    .argument("[harnessArgs...]", "arguments passed unchanged after --")
    .option("--executable <path>", "explicit real harness executable")
    .option("--sync-interval <seconds>", "periodic publish interval", "30")
    .action(async (
      harnessInput: string,
      harnessArgs: string[],
      options: { executable?: string; syncInterval: string },
    ) => {
      if (harnessInput !== "codex" && harnessInput !== "claude") throw new StatecaseUsageError("supported harnesses are codex and claude", 2);
      const harness: HarnessName = harnessInput;
      const intervalSeconds = Number(options.syncInterval);
      if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 0 || intervalSeconds > 86_400) {
        throw new StatecaseUsageError("--sync-interval must be an integer from 0 to 86400 seconds", 2);
      }
      const localConfig = normalizeConfig(await store.loadConfig());
      const executable = options.executable
        ? resolve(options.executable)
        : localConfig.runtime!.harnesses[harness]?.realExecutable ?? await resolveHarnessExecutable(harness, process.env, [argv[1] ?? ""]);
      const journal = new LocalStateStore(join(store.home, "state.db"));
      let liveKey: Buffer | undefined;
      const sync = async (reason: ReconcileReason): Promise<string | null> => {
        const { config, secrets, client } = await requireSession(store, io.fetch);
        const vaultId = selectedVault(config, secrets);
        liveKey ??= Buffer.from(secrets.vaultKeys[vaultId], "base64url");
        const engine = new SyncEngine(client, vaultId, liveKey);
        const result = reason === "preflight" ? await engine.pull(config) : await engine.push(config);
        if (reason === "preflight") await store.saveConfig(config);
        return result.revisionId;
      };
      const reconciler = new DurableReconciler(journal, sync, harness);
      const supervisor = new HarnessSupervisor({
        reconcile: (reason) => reconciler.reconcile(reason),
        intervalMs: intervalSeconds * 1000,
        warn: io.stderr,
      });
      try {
        const result = await supervisor.run({
          harness,
          executable,
          args: harnessArgs,
          cwd: process.cwd(),
          env: process.env,
        });
        requestedExitCode = result.exitCode;
      } finally {
        liveKey?.fill(0);
        journal.close();
      }
    });

  program.command("which")
    .description("show the Statecase shim and recorded real harness executable")
    .argument("<harness>", "codex or claude")
    .action(async (harnessInput: string) => {
      if (harnessInput !== "codex" && harnessInput !== "claude") throw new StatecaseUsageError("supported harnesses are codex and claude", 2);
      const config = normalizeConfig(await store.loadConfig());
      const record = config.runtime!.harnesses[harnessInput];
      if (!record) throw new StatecaseUsageError(`${harnessInput} is not configured for transparent execution`, 2);
      emit(io, program, { harness: harnessInput, shimPath: record.shimPath ?? null, realExecutable: record.realExecutable }, `${record.shimPath ?? "no shim"}\n${record.realExecutable}`);
    });

  program.command("bypass")
    .description("run the recorded real harness without synchronization")
    .argument("<harness>", "codex or claude")
    .argument("[harnessArgs...]", "arguments passed unchanged after --")
    .action(async (harnessInput: string, harnessArgs: string[]) => {
      if (harnessInput !== "codex" && harnessInput !== "claude") throw new StatecaseUsageError("supported harnesses are codex and claude", 2);
      const config = normalizeConfig(await store.loadConfig());
      const record = config.runtime!.harnesses[harnessInput];
      if (!record) throw new StatecaseUsageError(`${harnessInput} has no recorded real executable`, 2);
      const env = { ...process.env };
      delete env.STATECASE_ACTIVE_HARNESS;
      const supervisor = new HarnessSupervisor({ reconcile: async () => {}, intervalMs: 0, warn: io.stderr });
      requestedExitCode = (await supervisor.run({ harness: harnessInput, executable: record.realExecutable, args: harnessArgs, cwd: process.cwd(), env })).exitCode;
    });

  const shim = program.command("shim").description("inspect or remove transparent harness shims");
  shim.command("verify").argument("<harness>").action(async (harnessInput: string) => {
    if (harnessInput !== "codex" && harnessInput !== "claude") throw new StatecaseUsageError("supported harnesses are codex and claude", 2);
    const config = normalizeConfig(await store.loadConfig());
    const record = config.runtime!.harnesses[harnessInput];
    const valid = Boolean(record?.shimPath && await verifyHarnessShim(record.shimPath));
    emit(io, program, { harness: harnessInput, valid, shimPath: record?.shimPath ?? null }, valid ? `ok\t${record!.shimPath}` : `missing\t${record?.shimPath ?? "not configured"}`);
    if (!valid) requestedExitCode = 2;
  });
  shim.command("uninstall").argument("<harness>").requiredOption("--yes", "confirm removal").action(async (harnessInput: string) => {
    if (harnessInput !== "codex" && harnessInput !== "claude") throw new StatecaseUsageError("supported harnesses are codex and claude", 2);
    const config = normalizeConfig(await store.loadConfig());
    const record = config.runtime!.harnesses[harnessInput];
    const removed = record?.shimPath ? await removeHarnessShim(record.shimPath) : false;
    delete config.runtime!.harnesses[harnessInput];
    await store.saveConfig(config);
    emit(io, program, { harness: harnessInput, removed }, removed ? `Removed ${harnessInput} shim` : `${harnessInput} shim was not installed`);
  });

  const daemon = program.command("daemon").description("run and inspect persistent background synchronization");
  daemon.command("foreground")
    .description("run the persistent reconciler in the foreground")
    .option("--once", "perform startup reconciliation and exit")
    .action(async (options: { once?: boolean }) => {
      const initial = normalizeConfig(await store.loadConfig());
      const roots = [
        ...initial.mappings.map((mapping) => mapping.path),
        ...initial.workspaces.map((workspaceValue) => workspaceValue.path),
      ];
      const journal = new LocalStateStore(join(store.home, "state.db"));
      let liveKey: Buffer | undefined;
      const sync = async (reason: ReconcileReason): Promise<string | null> => {
        const { config, secrets, client } = await requireSession(store, io.fetch);
        const vaultId = selectedVault(config, secrets);
        liveKey ??= Buffer.from(secrets.vaultKeys[vaultId], "base64url");
        const engine = new SyncEngine(client, vaultId, liveKey);
        const pulled = await engine.pull(config);
        const result = reason === "preflight" ? pulled : await engine.push(config);
        await store.saveConfig(config);
        return result.revisionId ?? pulled.revisionId;
      };
      const reconciler = new DurableReconciler(journal, sync, "daemon");
      const runtime = new PersistentRuntime({
        lockPath: join(store.home, "daemon.lock"),
        socketPath: join(store.home, "daemon.sock"),
        roots,
        reconcile: (trigger: DaemonTrigger) => reconciler.reconcile(trigger === "startup" || trigger === "remote-poll" ? "preflight" : "periodic"),
        warn: io.stderr,
      });
      try {
        await runtime.start();
        emit(io, program, runtime.status(), options.once ? "Statecase reconciliation completed" : `Statecase daemon running with PID ${process.pid}`);
        if (!options.once) await waitForTermination();
      } finally {
        await runtime.stop();
        liveKey?.fill(0);
        journal.close();
      }
    });
  daemon.command("status").description("read daemon status over local IPC").action(async () => {
    try {
      const status = await readRuntimeStatus(join(store.home, "daemon.sock"));
      emit(io, program, status, `running; PID ${status.pid}; ${status.roots} roots; last ${status.lastTrigger ?? "never"}${status.queued ? "; sync queued" : ""}`);
    } catch {
      throw new StatecaseUsageError("Statecase daemon is not running", 8);
    }
  });
  daemon.command("install")
    .description("install and start the native per-user background service")
    .option("--no-start", "write the definition without activating it")
    .action(async (options: { start: boolean }) => {
      const definition = await daemonServiceDefinition(store, argv);
      const result = await installServiceDefinition(definition);
      if (options.start) await activateService(definition, "enable");
      emit(io, program, { ...result, platform: definition.source.platform, activated: options.start }, `${result.created ? "Installed" : "Verified"} ${definition.path}${options.start ? " and started the daemon" : ""}`);
    });
  daemon.command("uninstall")
    .description("stop and remove only the Statecase-owned background service")
    .requiredOption("--yes", "confirm removal")
    .option("--no-stop", "remove the definition without invoking the service manager")
    .action(async (options: { stop: boolean }) => {
      const definition = await daemonServiceDefinition(store, argv);
      if (options.stop) await activateService(definition, "disable");
      const removed = await removeServiceDefinition(definition);
      emit(io, program, { removed, platform: definition.source.platform, stopped: options.stop }, removed ? `Removed ${definition.path}` : "Statecase daemon service was not installed");
    });

  const skills = program.command("skills").description("install the agent-native Statecase skill");
  skills.command("install").option("--target <path>").action(async (options: { target?: string }) => {
    const targets = await installSkill(options.target ? [options.target] : undefined);
    emit(io, program, { targets }, `Installed Statecase skill in ${targets.join(" and ")}`);
  });
  skills.command("verify").option("--target <path>").action(async (options: { target?: string }) => {
    const targets = await verifySkill(options.target ? [options.target] : undefined);
    emit(io, program, { targets, valid: targets.every((target) => target.installed) }, targets.map((target) => `${target.installed ? "ok" : "missing"}\t${target.path}`).join("\n"));
  });
  skills.command("uninstall").requiredOption("--yes", "confirm removal").option("--target <path>").action(async (options: { target?: string }) => {
    const targets = await uninstallSkill(options.target ? [options.target] : undefined);
    emit(io, program, { targets }, `Removed Statecase skill from ${targets.join(" and ")}`);
  });

  for (const command of ["push", "pull", "sync"] as const) {
    program.command(command).option("--dry-run").action(async (options: { dryRun?: boolean }) => {
      const { config, secrets, client } = await requireSession(store, io.fetch);
      const vaultId = selectedVault(config, secrets);
      const key = Buffer.from(secrets.vaultKeys[vaultId], "base64url");
      const engine = new SyncEngine(client, vaultId, key);
      try {
        const results = [];
        if (command !== "push") results.push(await engine.pull(config, options.dryRun));
        if (command !== "pull") results.push(await engine.push(config, options.dryRun));
        if (!options.dryRun) await store.saveConfig(config);
        emit(io, program, { command, dryRun: Boolean(options.dryRun), results }, results.map((result) => `${result.outcome}: ${result.files} files, ${result.objects} objects, ${result.bytes} bytes`).join("\n"));
      } finally {
        key.fill(0);
      }
    });
  }

  program.command("status").action(async () => {
    const config = normalizeConfig(await store.loadConfig());
    const secrets = await store.loadSecrets();
    const data = { authenticated: Boolean(secrets.token), selectedVaultId: config.selectedVaultId ?? null, mappings: config.mappings, apiUrl: config.apiUrl };
    emit(io, program, data, `${data.authenticated ? "authenticated" : "not authenticated"}; ${config.mappings.length} mappings; vault ${data.selectedVaultId ?? "not selected"}`);
  });
  program.command("doctor").action(async () => {
    const config = normalizeConfig(await store.loadConfig());
    const secrets = await store.loadSecrets();
    const git = await promisify(execFile)("git", ["--version"]).then(() => true, () => false);
    const checks = { config: true, authenticated: Boolean(secrets.token), vaultKey: Boolean(config.selectedVaultId && secrets.vaultKeys[config.selectedVaultId]), git, mappings: config.mappings.length };
    emit(io, program, { healthy: checks.authenticated && checks.vaultKey && git, checks }, checks.authenticated && checks.vaultKey && git ? "Statecase is ready" : "Statecase needs Git, login, or vault selection");
  });

  try {
    await program.parseAsync(argv);
    return requestedExitCode;
  } catch (error) {
    if ((error as { code?: string }).code === "commander.helpDisplayed") return 0;
    const code = exitCodeFor(error);
    const message = error instanceof SyncConflict ? `${error.message}: ${error.paths.join(", ")}` : (error as Error).message;
    if (program.opts<{ json?: boolean }>().json) io.stderr(JSON.stringify({ error: { code, message } }));
    else io.stderr(`statecase: ${message}`);
    return code;
  }
}

function normalizeConfig(config: LocalConfig): LocalConfig {
  config.mappings ??= [];
  config.workspaces ??= [];
  config.applied ??= {};
  config.runtime ??= { harnesses: {} };
  config.runtime.harnesses ??= {};
  return config;
}

function emit(io: CliIO, program: Command, data: unknown, human: string): void {
  io.stdout(program.opts<{ json?: boolean }>().json ? JSON.stringify(data) : human);
}

function requireRecoveryPassphrase(): string {
  const value = process.env.STATECASE_RECOVERY_PASSPHRASE;
  if (!value || value.length < 12) throw new StatecaseUsageError("STATECASE_RECOVERY_PASSPHRASE must contain at least 12 characters", 2);
  return value;
}

function randomLocalId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function waitForTermination(): Promise<void> {
  return new Promise((resolveTermination) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolveTermination();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}

function daemonServiceDefinition(store: ConfigStore, argv: string[]) {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new StatecaseUsageError("native daemon services are supported on Linux and macOS", 2);
  }
  const platform: "linux" | "darwin" = process.platform;
  const statecaseExecutable = resolve(argv[1] ?? "statecase");
  return store.loadConfig().then((raw) => {
    const config = normalizeConfig(raw);
    return serviceDefinition({
      platform,
      home: homedir(),
      statecaseExecutable,
      statecaseHome: store.home,
      roots: [...config.mappings.map((mapping) => mapping.path), ...config.workspaces.map((workspace) => workspace.path)],
      ...(platform === "darwin" && process.getuid ? { uid: process.getuid() } : {}),
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runCli();
}
