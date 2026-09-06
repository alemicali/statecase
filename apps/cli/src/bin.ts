import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveClaudeRoot } from "@statecase/adapter-claude";
import { resolveCodexRoots } from "@statecase/adapter-codex";
import { randomKey } from "@statecase/crypto";
import { workspaceIdForRemote } from "@statecase/domain";
import { Command } from "commander";

import { StatecaseClient } from "./client.js";
import { ConfigStore, type LocalConfig, type RootMapping } from "./config.js";
import { readRecoveryKit, writeRecoveryKit } from "./recovery.js";
import { exitCodeFor, requireSession, selectedVault, StatecaseUsageError } from "./runtime.js";
import { installSkill, uninstallSkill, verifySkill } from "./skills.js";
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
  program.name("statecase").description("Take your agents anywhere.").option("--json", "emit stable JSON output");
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
      await new StatecaseClient(config.apiUrl, token, io.fetch).registerDevice({ name: deviceName });
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
    .action(async (options: { path: string; id?: string; auto?: boolean; name?: string }) => {
      const path = resolve(options.path);
      let id = options.id;
      if (!id && options.auto) {
        const { stdout } = await promisify(execFile)("git", ["-C", path, "config", "--get", "remote.origin.url"]);
        id = workspaceIdForRemote(stdout.trim());
      }
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) throw new StatecaseUsageError("provide --id or use --auto in a Git checkout", 2);
      const config = normalizeConfig(await store.loadConfig());
      config.workspaces = config.workspaces.filter((item) => item.id !== id && resolve(item.path) !== path);
      config.workspaces.push({ id, path, ...(options.name ? { name: options.name } : {}) });
      await store.saveConfig(config);
      emit(io, program, { id, path }, `Attached ${id} to ${path}`);
    });
  workspace.command("list").action(async () => {
    const workspaces = normalizeConfig(await store.loadConfig()).workspaces;
    emit(io, program, { workspaces }, workspaces.map((item) => `${item.id}\t${item.path}`).join("\n") || "No workspaces");
  });

  program.command("setup").requiredOption("--harness <names>", "codex, claude, or comma-separated values").action(async (options: { harness: string }) => {
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
    const skillTargets = await installSkill();
    await store.saveConfig(config);
    emit(io, program, { mappings: additions, skillTargets }, `Configured ${additions.map((item) => item.name).join(" and ")} and installed the Statecase skill`);
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
    const checks = { config: true, authenticated: Boolean(secrets.token), vaultKey: Boolean(config.selectedVaultId && secrets.vaultKeys[config.selectedVaultId]), mappings: config.mappings.length };
    emit(io, program, { healthy: checks.authenticated && checks.vaultKey, checks }, checks.authenticated && checks.vaultKey ? "Statecase is ready" : "Statecase needs login or vault selection");
  });

  try {
    await program.parseAsync(argv);
    return 0;
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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runCli();
}
