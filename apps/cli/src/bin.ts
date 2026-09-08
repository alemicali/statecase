import { homedir, hostname } from "node:os";
import { timingSafeEqual } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { chmod, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { resolveClaudeRoot } from "@statecase/adapter-claude";
import { resolveCodexRoots } from "@statecase/adapter-codex";
import { createDeviceExchangeKeyPair, openVaultKeyEnvelope, randomKey, sealVaultKeyForDevice } from "@statecase/crypto";
import { workspaceIdForRemote } from "@statecase/domain";
import { LocalStateStore } from "@statecase/storage-local";
import { ProfileLock } from "@statecase/runtime";
import { captureWorkspace } from "@statecase/workspace";
import { Command } from "commander";

import { RemoteError, StatecaseClient } from "./client.js";
import { assertNoHarnessProcess, HarnessActivityRegistry, type ActivityHandle } from "./activity.js";
import { createBootstrapCapability, openBootstrapCapability, type ScopedVaultKeys } from "./capability.js";
import { ConfigStore, type LocalConfig, type LocalSecrets, type RootMapping } from "./config.js";
import { PersistentRuntime, readRuntimeStatus, type DaemonTrigger } from "./daemon.js";
import { readRecoveryKeyringKit, writeRecoveryKeyringKit } from "./recovery.js";
import { DurableReconciler } from "./reconciler.js";
import { createEmergencySnapshot, inspectEmergencySnapshot, restoreEmergencySnapshot, type EmergencySnapshot } from "./emergency.js";
import { exitCodeFor, requireSession, selectedVault, StatecaseUsageError } from "./runtime.js";
import { activateService, installServiceDefinition, removeServiceDefinition, serviceDefinition } from "./service.js";
import { installHarnessShim, removeHarnessShim, verifyHarnessShim } from "./shims.js";
import { installSkill, uninstallSkill, verifySkill } from "./skills.js";
import { HarnessSupervisor, resolveHarnessExecutable, type HarnessName, type ReconcileReason } from "./supervisor.js";
import { SyncConflict, SyncEngine, type VaultKeyring } from "./sync.js";
import { decodeVaultKeyring, encodeVaultKeyring, refreshVaultKeyring, wipeVaultKeyring, withVaultKeyring } from "./vault-keys.js";

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
      const deviceExchange = secrets.deviceExchange ?? await createDeviceExchangeKeyPair();
      await new StatecaseClient(config.apiUrl, token, io.fetch).registerDevice({
        id: deviceId,
        name: deviceName,
        publicExchangeKey: deviceExchange.publicKey,
      });
      config.deviceId = deviceId;
      config.deviceName = deviceName;
      secrets.token = token;
      secrets.deviceExchange = deviceExchange;
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
    emit(io, program, { id: deviceId, revoked: true, keyRotationRequired: true }, `Revoked device ${deviceId}; rotate each affected vault key`);
  });

  const vault = program.command("vault").description("manage encrypted vaults");
  vault.command("create <name>").requiredOption("--recovery-file <path>").action(async (name: string, options: { recoveryFile: string }) => {
    const { config, secrets, client } = await requireSession(store, io.fetch);
    const passphrase = requireRecoveryPassphrase();
    const record = await client.createVault(name);
    const key = await randomKey();
    try {
      await writeRecoveryKeyringKit(resolve(options.recoveryFile), record.id, { currentEpoch: 1, keys: { 1: key } }, passphrase);
      secrets.vaultKeys[record.id] = Buffer.from(key).toString("base64url");
      secrets.vaultKeyrings ??= {};
      secrets.vaultKeyrings[record.id] = { currentEpoch: 1, keys: { 1: Buffer.from(key).toString("base64url") } };
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
    if (!secrets.vaultKeys[vaultId] && !secrets.scopedVaults?.[vaultId]) throw new StatecaseUsageError("vault key is not available on this device", 2);
    config.selectedVaultId = vaultId;
    await store.saveConfig(config);
    emit(io, program, { selectedVaultId: vaultId }, `Selected ${vaultId}`);
  });
  vault.command("join <vaultId>").requiredOption("--recovery-file <path>").action(async (vaultId: string, options: { recoveryFile: string }) => {
    const { config, secrets, client } = await requireSession(store, io.fetch);
    const keyring = await readRecoveryKeyringKit(resolve(options.recoveryFile), vaultId, requireRecoveryPassphrase());
    try {
      const record = await client.joinVault(vaultId, keyring.currentEpoch);
      secrets.vaultKeyrings ??= {};
      secrets.vaultKeyrings[vaultId] = encodeVaultKeyring(keyring);
      secrets.vaultKeys[vaultId] = Buffer.from(keyring.keys[keyring.currentEpoch]!).toString("base64url");
      config.selectedVaultId = vaultId;
      await Promise.all([store.saveConfig(config), store.saveSecrets(secrets)]);
      emit(io, program, record, `Joined and selected ${record.name ?? record.id}`);
    } catch (error) {
      if (error instanceof RemoteError && error.code === "KEY_EPOCH_CONFLICT") {
        throw new StatecaseUsageError("recovery kit does not contain the current vault key epoch", 6);
      }
      throw error;
    } finally {
      for (const key of Object.values(keyring.keys)) key.fill(0);
    }
  });

  const vaultKey = vault.command("key").description("manage encrypted vault-key epochs");
  vaultKey.command("rotate")
    .requiredOption("--recovery-file <path>", "new encrypted recovery keyring path")
    .requiredOption("--yes", "confirm cryptographic key rotation")
    .action(async (options: { recoveryFile: string; yes: boolean }) => {
      const { config, secrets, client } = await requireSession(store, io.fetch);
      const vaultId = selectedVault(config, secrets);
      const deviceId = config.deviceId;
      const deviceExchange = secrets.deviceExchange;
      if (!deviceId || !deviceExchange) throw new StatecaseUsageError("log in again to initialize this device's exchange key", 3);
      return withVaultKeyring(secrets, vaultId, async (keyring) => {
        const recipients = await client.vaultKeyRecipients(vaultId);
        if (recipients.keyEpoch !== keyring.currentEpoch) throw new StatecaseUsageError("refresh the latest vault key before rotating it", 5);
        if (!recipients.devices.some((device) => device.id === config.deviceId)) {
          throw new StatecaseUsageError("the current device is not an eligible key recipient", 4);
        }
        const scoped = await client.namespaceHeads(vaultId);
        if (scoped.namespaces.length === 0 && (await client.head(vaultId)).revisionId) {
          throw new StatecaseUsageError("synchronize once to migrate the vault to protocol 1.1 before rotating keys", 5);
        }
        const newEpoch = keyring.currentEpoch + 1;
        const newKey = await randomKey();
        const recoveryFile = resolve(options.recoveryFile);
        const nextKeyring = { currentEpoch: newEpoch, keys: { ...keyring.keys, [newEpoch]: newKey } };
        let remoteRotated = false;
        let recoveryCreated = false;
        let preserveRecovery = false;
        let reconciled = false;
        try {
          await writeRecoveryKeyringKit(recoveryFile, vaultId, nextKeyring, requireRecoveryPassphrase());
          recoveryCreated = true;
          const envelopes = await Promise.all(recipients.devices.map(async (device) => ({
            deviceId: device.id,
            envelope: await sealVaultKeyForDevice({
              vaultId,
              keyEpoch: newEpoch,
              deviceId: device.id,
              vaultKey: newKey,
              recipientPublicKey: device.publicExchangeKey,
            }),
          })));
          let rotated: { keyEpoch: number; rotated: true };
          try {
            rotated = await client.rotateVaultKey(vaultId, {
              expectedEpoch: keyring.currentEpoch,
              newEpoch,
              envelopes,
            });
            remoteRotated = true;
          } catch (error) {
            if (!isAmbiguousRemoteMutation(error)) throw error;
            const outcome = await reconcileVaultKeyRotation({
              client,
              vaultId,
              expectedEpoch: keyring.currentEpoch,
              newEpoch,
              newKey,
              deviceId,
              deviceExchange,
            });
            if (outcome === "unknown") {
              preserveRecovery = true;
              throw new StatecaseUsageError(
                `vault key rotation outcome is unknown; recovery kit preserved at ${recoveryFile}; run statecase sync before retrying`,
                7,
              );
            }
            if (outcome === "not-committed") throw error;
            remoteRotated = true;
            reconciled = true;
            rotated = { keyEpoch: newEpoch, rotated: true };
          }
          secrets.vaultKeyrings ??= {};
          secrets.vaultKeyrings[vaultId] = encodeVaultKeyring(nextKeyring);
          secrets.vaultKeys[vaultId] = Buffer.from(newKey).toString("base64url");
          await store.saveSecrets(secrets);
          emit(io, program, { ...rotated, reconciled, recoveryFile, rekeyPending: scoped.namespaces.length > 0 }, `Rotated ${vaultId} to key epoch ${newEpoch}`);
        } catch (error) {
          if (recoveryCreated && !remoteRotated && !preserveRecovery) await unlink(recoveryFile).catch(() => undefined);
          throw error;
        } finally {
          newKey.fill(0);
        }
      });
    });

  const token = program.command("token").description("grant and revoke short-lived namespace capabilities");
  token.command("create")
    .requiredOption("--namespace <names>", "comma-separated namespace IDs")
    .option("--actions <actions>", "read or read,append", "read")
    .option("--ttl <minutes>", "lifetime in minutes (1-1440)", "60")
    .requiredOption("--output <path>", "new protected bootstrap-token file")
    .action(async (options: { namespace: string; actions: string; ttl: string; output: string }) => {
      const { config, secrets, client } = await requireSession(store, io.fetch);
      const vaultId = selectedVault(config, secrets);
      if (!secrets.vaultKeys[vaultId] && !secrets.vaultKeyrings?.[vaultId]) throw new StatecaseUsageError("a full vault key is required to grant a capability", 4);
      return withVaultKeyring(secrets, vaultId, async (vaultKeyring) => {
        const namespaces = parseCsv(options.namespace);
        const actions = parseCapabilityActions(options.actions);
        const namespaceHeads = new Map((await client.namespaceHeads(vaultId)).namespaces.map((head) => [head.namespace, head]));
        const staleEpochNamespaces = namespaces.filter((namespace) => {
          const head = namespaceHeads.get(namespace);
          return head && (head.keyEpoch ?? 1) !== vaultKeyring.currentEpoch;
        });
        if (staleEpochNamespaces.length > 0) {
          throw new StatecaseUsageError(`synchronize rotated namespaces before granting a capability: ${staleEpochNamespaces.join(", ")}`, 5);
        }
        const ttlMinutes = Number(options.ttl);
        if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
          throw new StatecaseUsageError("--ttl must be an integer from 1 to 1440 minutes", 2);
        }
        const expiresAt = Date.now() + ttlMinutes * 60_000;
        const vaultKey = vaultKeyring.keys[vaultKeyring.currentEpoch]!;
        const outputPath = resolve(options.output);
        const material = await createBootstrapCapability({ vaultId, keyEpoch: vaultKeyring.currentEpoch, vaultKey, namespaces, actions, expiresAt });
        await writeProtectedBootstrapFile(outputPath, `${material.bootstrapToken}\n`);
        let record;
        try {
          record = await client.createCapability({
            id: randomLocalId("cap"),
            vaultId,
            keyEpoch: vaultKeyring.currentEpoch,
            tokenHash: material.tokenHash,
            namespaces,
            actions,
            expiresAt,
            keyEnvelope: material.keyEnvelope,
          });
        } catch (error) {
          await unlink(outputPath).catch(() => undefined);
          throw error;
        }
        emit(io, program, { capability: record, bootstrapFile: outputPath }, `Created ${record.id}; bootstrap token written to ${outputPath}`);
      });
    });
  token.command("list").action(async () => {
    const { client } = await requireSession(store, io.fetch);
    const records = await client.listCapabilities();
    emit(io, program, { tokens: records }, records.map((item) => `${item.id}\t${item.revokedAt ? "revoked" : item.redeemedAt ? "redeemed" : "ready"}\t${item.vaultId}\t${item.namespaces.join(",")}`).join("\n") || "No capability tokens");
  });
  token.command("revoke <tokenId>").requiredOption("--yes", "confirm revocation").action(async (tokenId: string) => {
    const { client } = await requireSession(store, io.fetch);
    await client.revokeCapability(tokenId);
    emit(io, program, { id: tokenId, revoked: true }, `Revoked capability ${tokenId}`);
  });

  program.command("bootstrap")
    .description("redeem a one-time scoped capability on an ephemeral machine")
    .option("--token-file <path>", "protected file containing the bootstrap token")
    .option("--non-interactive")
    .action(async (options: { tokenFile?: string; nonInteractive?: boolean }) => {
      const config = normalizeConfig(await store.loadConfig());
      const secrets = await store.loadSecrets();
      if (secrets.token || Object.keys(secrets.vaultKeys).length > 0 || Object.keys(secrets.scopedVaults ?? {}).length > 0) {
        throw new StatecaseUsageError("bootstrap requires a fresh STATECASE_HOME with no existing credentials", 2);
      }
      const bootstrapToken = process.env.STATECASE_BOOTSTRAP_TOKEN ??
        (options.tokenFile ? await readBootstrapTokenFile(resolve(options.tokenFile)) : undefined);
      if (!bootstrapToken) {
        throw new StatecaseUsageError("provide --token-file or STATECASE_BOOTSTRAP_TOKEN", options.nonInteractive ? 3 : 2);
      }
      const publicClient = new StatecaseClient(config.apiUrl, undefined, io.fetch);
      const redemption = await publicClient.redeemBootstrap(bootstrapToken);
      const scoped = await openBootstrapCapability({ bootstrapToken, ...redemption });
      secrets.token = redemption.accessToken;
      secrets.scopedVaults ??= {};
      secrets.scopedVaults[redemption.vaultId] = scoped;
      config.selectedVaultId = redemption.vaultId;
      await Promise.all([store.saveConfig(config), store.saveSecrets(secrets)]);
      emit(io, program, {
        authenticated: true,
        vaultId: redemption.vaultId,
        namespaces: redemption.namespaces,
        actions: redemption.actions,
        expiresAt: redemption.expiresAt,
      }, `Bootstrapped scoped access to ${redemption.vaultId} until ${new Date(redemption.expiresAt).toISOString()}`);
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

  const retention = program.command("retention").description("preview and run encrypted-object retention");
  retention.command("plan").description("preview objects eligible after checkpoint and grace rules").action(async () => {
    const { config, secrets, client } = await requireSession(store, io.fetch);
    const result = await client.garbageCollect(selectedVault(config, secrets), true);
    emit(io, program, result, `Would collect ${result.candidateObjects} objects (${result.deleteBytes} encrypted bytes)`);
  });
  retention.command("collect").description("delete only unreachable encrypted objects after the grace period")
    .option("--yes", "confirm garbage collection")
    .action(async (options: { yes?: boolean }) => {
      if (!options.yes) throw new StatecaseUsageError("garbage collection requires --yes", 2);
      const { config, secrets, client } = await requireSession(store, io.fetch);
      const result = await client.garbageCollect(selectedVault(config, secrets), false);
      emit(io, program, result, `Collected ${result.deletedObjects} objects (${result.deleteBytes} encrypted bytes)`);
    });

  program.command("restore")
    .description("restore one namespace from an immutable historical revision")
    .requiredOption("--revision <revisionId>")
    .requiredOption("--mapping <mappingId>", "Drop/harness mapping ID or workspace ID")
    .option("--target <path>", "staging target; with --in-place it must equal the configured path")
    .option("--in-place", "replace the configured Drop/harness state and publish a new revision")
    .option("--dry-run")
    .option("--yes", "confirm a non-empty staging target or in-place replacement")
    .action(async (options: { revision: string; mapping: string; target?: string; inPlace?: boolean; dryRun?: boolean; yes?: boolean }) => {
      const { config, secrets, client } = await requireSession(store, io.fetch);
      const vaultId = selectedVault(config, secrets);
      const mapping = config.mappings.find((item) => item.id === options.mapping);
      const workspace = config.workspaces.find((item) => item.id === options.mapping);
      if (!mapping && !workspace) throw new StatecaseUsageError("restore mapping is not configured on this device", 2);
      if (mapping && workspace) throw new StatecaseUsageError("restore mapping ID is ambiguous", 2);
      if (options.inPlace && workspace?.sync === "identity-only") {
        throw new StatecaseUsageError("metadata-only workspaces have no Git state to restore", 2);
      }
      const inPlaceMapping: RootMapping | undefined = mapping ?? (workspace ? {
        id: `workspace_${workspace.id}`,
        kind: "drop",
        mode: "two-way",
        name: workspace.name ?? workspace.id,
        namespace: `workspace:${workspace.id}`,
        path: resolve(workspace.path),
      } : undefined);
      if (options.inPlace && inPlaceMapping!.mode !== "two-way") throw new StatecaseUsageError("in-place restore requires a two-way mapping", 2);
      if (options.inPlace && !options.dryRun && !options.yes) throw new StatecaseUsageError("in-place restore requires --yes", 2);
      if (!options.inPlace && !options.target) throw new StatecaseUsageError("staging restore requires --target", 2);
      const configuredTarget = resolve(mapping?.path ?? workspace!.path);
      const target = options.inPlace ? configuredTarget : resolve(options.target!);
      if (options.inPlace && options.target && resolve(options.target) !== configuredTarget) {
        throw new StatecaseUsageError("--in-place target must equal the configured mapping path", 2);
      }
      if (!options.inPlace && target === configuredTarget) {
        throw new StatecaseUsageError("restoring to the configured mapping path requires --in-place", 2);
      }
      const targetInfo = await lstat(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (targetInfo && !targetInfo.isDirectory()) throw new StatecaseUsageError("restore target must be a directory", 2);
      if (!options.inPlace && targetInfo && (await readdir(target)).length > 0 && !options.yes) {
        throw new StatecaseUsageError("non-empty restore target requires --yes", 2);
      }
      if (options.inPlace && !targetInfo) throw new StatecaseUsageError("configured in-place restore target is missing", 2);
      const restoreConfig = structuredClone(config);
      if (!options.inPlace) restoreConfig.applied = {};
      if (mapping && !options.inPlace) {
        restoreConfig.mappings = [{ ...mapping, mode: "consume", path: target }];
        restoreConfig.workspaces = restoreConfig.workspaces.map((item) => ({ ...item, sync: "identity-only" }));
      } else if (!options.inPlace) {
        restoreConfig.mappings = [];
        restoreConfig.workspaces = [{ ...workspace!, path: target, sync: "git" }];
      }
      const key = await syncAccess(store, config, secrets, client, vaultId);
      let daemonBarrier: ProfileLock | undefined;
      let harnessBarrier: ActivityHandle | undefined;
      let emergency: EmergencySnapshot | undefined;
      try {
        const engine = new SyncEngine(client, vaultId, key);
        if (!options.inPlace) {
          const result = await engine.pull(restoreConfig, options.dryRun, options.revision);
          emit(io, program, { revisionId: options.revision, mappingId: options.mapping, target, mode: "staging", dryRun: Boolean(options.dryRun), result },
            `${options.dryRun ? "Would restore" : "Restored"} ${result.files} files from ${options.revision} to ${target}`);
          return;
        }
        let protectedSnapshot: Awaited<ReturnType<StatecaseClient["createSnapshot"]>> | undefined;
        if (!options.dryRun) {
          try {
            daemonBarrier = await ProfileLock.acquire(join(store.home, "daemon.lock"));
          } catch {
            throw new StatecaseUsageError("stop the Statecase daemon before in-place restore", 5);
          }
          if (mapping && mapping.kind !== "drop") {
            const activity = new HarnessActivityRegistry(join(store.home, "locks", "harnesses"));
            try {
              harnessBarrier = await activity.beginRestore(mapping.kind);
              await assertNoHarnessProcess(mapping.kind);
            } catch {
              await harnessBarrier?.release();
              harnessBarrier = undefined;
              throw new StatecaseUsageError(`stop ${mapping.kind} before in-place restore`, 5);
            }
          }
          protectedSnapshot = await client.createSnapshot(vaultId, `Before in-place restore of ${inPlaceMapping!.id}`);
        }
        const result = await engine.restoreInPlace(restoreConfig, inPlaceMapping!, options.revision, {
          dryRun: options.dryRun,
          ...(!options.dryRun ? {
            prepareRecovery: async (paths, context) => {
              emergency = await createEmergencySnapshot({
                id: randomLocalId("restore"),
                createdAt: new Date().toISOString(),
                statecaseHome: store.home,
                targetRoot: target,
                paths,
                ...(context ? { workspace: { targetHeadRef: context.targetHeadRef } } : mapping?.kind === "drop" || !mapping ? {} : { harness: mapping.kind }),
              });
              return { rollback: () => restoreEmergencySnapshot(emergency!.path) };
            },
          } : {}),
        });
        if (!options.dryRun) {
          config.applied[inPlaceMapping!.namespace] = restoreConfig.applied[inPlaceMapping!.namespace]!;
          config.sessionBindings = restoreConfig.sessionBindings;
          await store.saveConfig(config);
        }
        emit(io, program, {
          revisionId: options.revision,
          mappingId: options.mapping,
          target,
          mode: "in-place",
          dryRun: Boolean(options.dryRun),
          protectedSnapshotId: protectedSnapshot?.id ?? null,
          emergencySnapshotPath: emergency?.path ?? null,
          result,
        }, `${options.dryRun ? "Would restore" : "Restored"} ${result.files} files in place from ${options.revision}${result.revisionId ? ` as ${result.revisionId}` : ""}`);
      } finally {
        await harnessBarrier?.release();
        await daemonBarrier?.release();
        wipeSyncAccess(key);
      }
    });

  const emergencyCommand = program.command("emergency").description("inspect and apply local emergency restore snapshots");
  emergencyCommand.command("rollback")
    .argument("<snapshot>")
    .option("--yes", "confirm local rollback")
    .action(async (snapshotInput: string, options: { yes?: boolean }) => {
      if (!options.yes) throw new StatecaseUsageError("emergency rollback requires --yes", 2);
      const snapshotPath = resolve(snapshotInput);
      const snapshot = await inspectEmergencySnapshot(snapshotPath);
      let daemonBarrier: ProfileLock | undefined;
      let harnessBarrier: ActivityHandle | undefined;
      try {
        try {
          daemonBarrier = await ProfileLock.acquire(join(store.home, "daemon.lock"));
        } catch {
          throw new StatecaseUsageError("stop the Statecase daemon before emergency rollback", 5);
        }
        if (snapshot.harness) {
          const activity = new HarnessActivityRegistry(join(store.home, "locks", "harnesses"));
          try {
            harnessBarrier = await activity.beginRestore(snapshot.harness);
            await assertNoHarnessProcess(snapshot.harness);
          } catch {
            await harnessBarrier?.release();
            harnessBarrier = undefined;
            throw new StatecaseUsageError(`stop ${snapshot.harness} before emergency rollback`, 5);
          }
        }
        await restoreEmergencySnapshot(snapshotPath);
        emit(io, program, { ...snapshot, snapshotPath, restored: true }, `Restored ${snapshot.records} paths from ${snapshot.id}`);
      } finally {
        await harnessBarrier?.release();
        await daemonBarrier?.release();
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
      const expectedHeadRevisionId = (await client.namespaceHeads(vaultId)).revisionId ?? snapshot.revisionId;
      const resolveConfig = structuredClone(config);
      if (mapping) {
        resolveConfig.mappings = [mapping];
        resolveConfig.workspaces = resolveConfig.workspaces.map((item) => ({ ...item, sync: "identity-only" }));
      } else {
        resolveConfig.mappings = [];
        resolveConfig.workspaces = [workspace!];
      }
      const key = await syncAccess(store, config, secrets, client, vaultId);
      try {
        const result = await new SyncEngine(client, vaultId, key).push(resolveConfig, false, {
          resolveLocalNamespaces: new Set([namespace]),
          expectedHeadRevisionId,
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
        wipeSyncAccess(key);
      }
    });

  const drop = program.command("drop").description("map arbitrary synchronized directories");
  drop.command("add <path>").requiredOption("--name <name>").option("--mode <mode>", "two-way, publish, consume, or append", "two-way").action(async (path: string, options: { name: string; mode: string }) => {
    const mode = parseDropMode(options.mode);
    const config = normalizeConfig(await store.loadConfig());
    const id = randomLocalId("drop");
    config.mappings.push({ id, kind: "drop", mode, name: options.name, namespace: `drop:${id}`, path: resolve(path) });
    await store.saveConfig(config);
    emit(io, program, { id, name: options.name, path: resolve(path), mode }, `Added Drop ${options.name} (${id})`);
  });
  drop.command("map <dropId> <path>").option("--name <name>").option("--mode <mode>", "mapping mode").action(async (dropId: string, path: string, options: { name?: string; mode?: string }) => {
    const config = normalizeConfig(await store.loadConfig());
    const previous = config.mappings.find((item) => item.kind === "drop" && item.id === dropId);
    const mode = parseDropMode(options.mode ?? previous?.mode ?? "two-way");
    const resolvedPath = resolve(path);
    if (previous && resolve(previous.path) !== resolvedPath) delete config.applied[previous.namespace];
    config.mappings = config.mappings.filter((item) => item.kind !== "drop" || item.id !== dropId);
    config.mappings.push({ id: dropId, kind: "drop", mode, name: options.name ?? previous?.name ?? dropId, namespace: `drop:${dropId}`, path: resolvedPath });
    await store.saveConfig(config);
    emit(io, program, { id: dropId, path: resolvedPath, mode }, `Mapped ${dropId} to ${resolvedPath}`);
  });
  drop.command("list").action(async () => {
    const mappings = normalizeConfig(await store.loadConfig()).mappings.filter((item) => item.kind === "drop");
    emit(io, program, { drops: mappings }, mappings.map((item) => `${item.id}\t${item.mode}\t${item.path}`).join("\n") || "No Drops");
  });
  drop.command("remove <dropId>")
    .description("remove a device-local Drop mapping without deleting files or cloud state")
    .action(async (dropId: string) => {
      const config = normalizeConfig(await store.loadConfig());
      const index = config.mappings.findIndex((item) => item.kind === "drop" && item.id === dropId);
      if (index < 0) throw new StatecaseUsageError(`Drop is not mapped on this device: ${dropId}`, 2);
      const [removed] = config.mappings.splice(index, 1);
      delete config.applied[removed!.namespace];
      await store.saveConfig(config);
      emit(io, program, { id: dropId, path: resolve(removed!.path), removed: true }, `Removed Drop ${dropId} mapping; local files and cloud state were not changed`);
    });
  drop.command("status [dropId]")
    .description("compare local Drop availability and applied revisions with remote heads")
    .action(async (dropId?: string) => {
      const localConfig = normalizeConfig(await store.loadConfig());
      const selected = localConfig.mappings.filter((item) => item.kind === "drop" && (!dropId || item.id === dropId));
      if (dropId && selected.length === 0) throw new StatecaseUsageError(`Drop is not mapped on this device: ${dropId}`, 2);
      const { config, secrets, client } = await requireSession(store, io.fetch);
      const vaultId = selectedVault(config, secrets);
      const scoped = secrets.scopedVaults?.[vaultId];
      const fullAccess = Boolean(secrets.vaultKeys[vaultId]);
      const remotelyVisible = selected.filter((mapping) => fullAccess || scoped?.namespaces.includes(mapping.namespace));
      const heads = remotelyVisible.length > 0
        ? new Map((await client.namespaceHeads(vaultId)).namespaces.map((head) => [head.namespace, head.revisionId]))
        : new Map<string, string>();
      const statuses = await Promise.all(selected.map(async (mapping) => {
        const appliedRevisionId = config.applied[mapping.namespace]?.revisionId ?? null;
        const authorized = fullAccess || Boolean(scoped?.namespaces.includes(mapping.namespace));
        const remoteRevisionId = authorized ? heads.get(mapping.namespace) ?? null : null;
        const remoteRelation = !authorized
          ? "unauthorized"
          : remoteRevisionId === null
            ? appliedRevisionId === null ? "uninitialized" : "remote-missing"
            : remoteRevisionId === appliedRevisionId ? "applied" : "remote-ahead";
        return {
          id: mapping.id,
          name: mapping.name,
          mode: mapping.mode,
          namespace: mapping.namespace,
          path: resolve(mapping.path),
          localState: await dropLocalState(mapping.path),
          appliedRevisionId,
          remoteRevisionId,
          remoteRelation,
        };
      }));
      emit(io, program, { drops: statuses }, statuses.map((status) => `${status.id}\t${status.localState}\t${status.remoteRelation}\t${status.path}`).join("\n") || "No Drops");
    });

  const workspace = program.command("workspace").description("map logical projects independently of absolute paths");
  workspace.command("attach")
    .option("--path <path>", "local checkout", process.cwd())
    .option("--id <workspaceId>")
    .option("--auto", "derive identity from the Git origin")
    .option("--name <name>")
    .option("--mode <mode>", "git-overlay or metadata-only", "git-overlay")
    .option("--git-fetch <policy>", "ask, auto, or never", "ask")
    .action(async (options: { path: string; id?: string; auto?: boolean; name?: string; mode: string; gitFetch: string }) => {
      const path = resolve(options.path);
      if (options.mode !== "git-overlay" && options.mode !== "metadata-only") {
        throw new StatecaseUsageError("workspace mode must be git-overlay or metadata-only", 2);
      }
      if (options.gitFetch !== "ask" && options.gitFetch !== "auto" && options.gitFetch !== "never") {
        throw new StatecaseUsageError("--git-fetch must be ask, auto, or never", 2);
      }
      if (options.mode === "git-overlay" && !await isGitWorkingTree(path)) {
        throw new StatecaseUsageError("git-overlay requires a Git working tree; use --mode metadata-only for identity mapping", 2);
      }
      let id = options.id;
      if (!id && options.auto) {
        const { stdout } = await promisify(execFile)("git", ["-C", path, "config", "--get", "remote.origin.url"])
          .catch(() => { throw new StatecaseUsageError("--auto requires a Git origin; provide --id explicitly", 2); });
        id = workspaceIdForRemote(stdout.trim());
      }
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) throw new StatecaseUsageError("provide --id or use --auto in a Git checkout", 2);
      const config = normalizeConfig(await store.loadConfig());
      for (const previous of config.workspaces) {
        if ((previous.id === id || resolve(previous.path) === path) && (previous.id !== id || resolve(previous.path) !== path)) {
          delete config.applied[`workspace:${previous.id}`];
        }
      }
      config.workspaces = config.workspaces.filter((item) => item.id !== id && resolve(item.path) !== path);
      config.workspaces.push({
        id,
        path,
        sync: options.mode === "metadata-only" ? "identity-only" : "git",
        gitFetch: options.gitFetch,
        ...(options.name ? { name: options.name } : {}),
      });
      await store.saveConfig(config);
      emit(io, program, { id, path, mode: options.mode, gitFetch: options.gitFetch }, `Attached ${id} to ${path} (${options.mode}; Git fetch ${options.gitFetch})`);
    });
  workspace.command("list").action(async () => {
    const workspaces = normalizeConfig(await store.loadConfig()).workspaces;
    emit(io, program, { workspaces }, workspaces.map((item) => `${item.id}\t${item.sync === "identity-only" ? "metadata-only" : "git-overlay"}\t${item.gitFetch ?? "ask"}\t${item.path}`).join("\n") || "No workspaces");
  });
  workspace.command("move <workspaceId> <path>")
    .description("change a workspace's device-local path without moving files")
    .action(async (workspaceId: string, pathValue: string) => {
      const path = resolve(pathValue);
      const config = normalizeConfig(await store.loadConfig());
      const index = config.workspaces.findIndex((item) => item.id === workspaceId);
      if (index < 0) throw new StatecaseUsageError(`workspace is not attached on this device: ${workspaceId}`, 2);
      const current = config.workspaces[index]!;
      const previousPath = resolve(current.path);
      if (previousPath === path) {
        emit(io, program, { id: workspaceId, previousPath, path, moved: false }, `Workspace ${workspaceId} already maps to ${path}`);
        return;
      }
      const occupied = config.workspaces.find((item, candidateIndex) => candidateIndex !== index && resolve(item.path) === path);
      if (occupied) throw new StatecaseUsageError(`workspace path is already attached to ${occupied.id}: ${path}`, 2);
      if (current.sync !== "identity-only" && !await isGitWorkingTree(path)) {
        throw new StatecaseUsageError("git-overlay requires a Git working tree; use workspace attach --mode metadata-only for identity mapping", 2);
      }
      config.workspaces[index] = { ...current, path };
      delete config.applied[`workspace:${workspaceId}`];
      await store.saveConfig(config);
      emit(io, program, { id: workspaceId, previousPath, path, moved: true }, `Moved workspace ${workspaceId} mapping from ${previousPath} to ${path}`);
    });
  workspace.command("detach <workspaceId>")
    .description("remove a device-local workspace mapping without deleting files or cloud state")
    .action(async (workspaceId: string) => {
      const config = normalizeConfig(await store.loadConfig());
      const index = config.workspaces.findIndex((item) => item.id === workspaceId);
      if (index < 0) throw new StatecaseUsageError(`workspace is not attached on this device: ${workspaceId}`, 2);
      const [removed] = config.workspaces.splice(index, 1);
      delete config.applied[`workspace:${workspaceId}`];
      await store.saveConfig(config);
      emit(io, program, { id: workspaceId, path: resolve(removed!.path), detached: true }, `Detached workspace ${workspaceId}; local files and cloud state were not changed`);
    });
  workspace.command("capsule <workspaceId>")
    .description("preview local Git workspace capsule metadata without syncing")
    .action(async (workspaceId: string) => {
      const config = normalizeConfig(await store.loadConfig());
      const mapping = config.workspaces.find((item) => item.id === workspaceId);
      if (!mapping) throw new StatecaseUsageError(`workspace is not attached on this device: ${workspaceId}`, 2);
      if (mapping.sync === "identity-only") throw new StatecaseUsageError(`workspace ${workspaceId} is metadata-only and has no Git capsule`, 2);
      const path = resolve(mapping.path);
      const captured = await captureWorkspace(path, { gitFetch: "ask" });
      const blobBytes = captured.blobs.reduce((total, blob) => total + blob.bytes.byteLength, 0);
      const preview = {
        workspaceId,
        path,
        mode: "git-overlay" as const,
        baseCommit: captured.capsule.baseCommit,
        headRef: captured.capsule.headRef,
        recordCount: captured.capsule.records.length,
        blobCount: captured.blobs.length,
        blobBytes,
      };
      emit(io, program, preview, `${workspaceId}: ${preview.recordCount} overlay records, ${preview.blobCount} blobs, ${preview.blobBytes} bytes; baseline ${preview.baseCommit ?? "unborn"}`);
    });
  workspace.command("dependencies")
    .description("inspect the immutable dependency closure recorded for resumable sessions")
    .option("--workspace <workspaceId>")
    .option("--revision <revisionId>")
    .action(async (options: { workspace?: string; revision?: string }) => {
      const { config, secrets, client } = await requireSession(store, io.fetch);
      const vaultId = selectedVault(config, secrets);
      const key = await syncAccess(store, config, secrets, client, vaultId);
      try {
        const reports = (await new SyncEngine(client, vaultId, key).dependencies(options.revision))
          .filter((report) => !options.workspace || report.workspace.workspaceId === options.workspace);
        const unresolved = reports.reduce((total, report) =>
          total + report.dependencies.filter((dependency) => dependency.status === "unresolved").length, 0);
        emit(io, program, { reports, unresolved }, reports.length === 0
          ? "No resumable session capsules"
          : `${reports.length} session capsule${reports.length === 1 ? "" : "s"}; ${unresolved} unresolved dependenc${unresolved === 1 ? "y" : "ies"}`);
      } finally {
        wipeSyncAccess(key);
      }
    });
  workspace.command("hydrate")
    .description("materialize the exact dependency closure pinned by a session capsule")
    .requiredOption("--session <sessionCapsuleId>")
    .option("--mode <mode>", "strict, warn, or best-effort", "warn")
    .option("--dry-run")
    .action(async (options: { session: string; mode: string; dryRun?: boolean }) => {
      if (options.mode !== "strict" && options.mode !== "warn" && options.mode !== "best-effort") {
        throw new StatecaseUsageError("hydration mode must be strict, warn, or best-effort", 2);
      }
      const { config, secrets, client } = await requireSession(store, io.fetch);
      const vaultId = selectedVault(config, secrets);
      const key = await syncAccess(store, config, secrets, client, vaultId);
      try {
        const hydrated = await new SyncEngine(client, vaultId, key).hydrate(config, options.session, {
          mode: options.mode,
          dryRun: options.dryRun,
        });
        if (!options.dryRun) await store.saveConfig(config);
        if (options.mode === "warn" && hydrated.warnings.length > 0) requestedExitCode = 8;
        emit(io, program, { sessionCapsuleId: options.session, mode: options.mode, dryRun: Boolean(options.dryRun), ...hydrated },
          `${options.dryRun ? "Would hydrate" : "Hydrated"} ${hydrated.report.sessionKey} from ${hydrated.result.revisionId}; ${hydrated.warnings.length} warning${hydrated.warnings.length === 1 ? "" : "s"}`);
      } finally {
        wipeSyncAccess(key);
      }
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
      const sync = async (reason: ReconcileReason): Promise<string | null> => {
        const { config, secrets, client } = await requireSession(store, io.fetch);
        const vaultId = selectedVault(config, secrets);
        const liveKey = await syncAccess(store, config, secrets, client, vaultId);
        try {
          const engine = new SyncEngine(client, vaultId, liveKey);
          const result = reason === "preflight" ? await engine.pull(config) : await engine.push(config);
          await store.saveConfig(config);
          return result.revisionId;
        } finally {
          wipeSyncAccess(liveKey);
        }
      };
      const reconciler = new DurableReconciler(journal, sync, harness);
      const supervisor = new HarnessSupervisor({
        reconcile: (reason) => reconciler.reconcile(reason),
        intervalMs: intervalSeconds * 1000,
        warn: io.stderr,
      });
      const activity = await new HarnessActivityRegistry(join(store.home, "locks", "harnesses")).enter(harness);
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
        await activity.release();
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
      const activity = await new HarnessActivityRegistry(join(store.home, "locks", "harnesses")).enter(harnessInput);
      try {
        requestedExitCode = (await supervisor.run({ harness: harnessInput, executable: record.realExecutable, args: harnessArgs, cwd: process.cwd(), env })).exitCode;
      } finally {
        await activity.release();
      }
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
      const sync = async (reason: ReconcileReason): Promise<string | null> => {
        const { config, secrets, client } = await requireSession(store, io.fetch);
        const vaultId = selectedVault(config, secrets);
        const liveKey = await syncAccess(store, config, secrets, client, vaultId);
        try {
          const engine = new SyncEngine(client, vaultId, liveKey);
          const pulled = await engine.pull(config);
          const result = reason === "preflight" ? pulled : await engine.push(config);
          await store.saveConfig(config);
          return result.revisionId ?? pulled.revisionId;
        } finally {
          wipeSyncAccess(liveKey);
        }
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
      const key = await syncAccess(store, config, secrets, client, vaultId);
      const engine = new SyncEngine(client, vaultId, key);
      try {
        const results = [];
        if (command !== "push") results.push(await engine.pull(config, options.dryRun));
        if (command !== "pull") results.push(await engine.push(config, options.dryRun));
        if (!options.dryRun) await store.saveConfig(config);
        emit(io, program, { command, dryRun: Boolean(options.dryRun), results }, results.map((result) => `${result.outcome}: ${result.files} files, ${result.objects} objects, ${result.bytes} bytes`).join("\n"));
      } finally {
        wipeSyncAccess(key);
      }
    });
  }

  program.command("status").action(async () => {
    const config = normalizeConfig(await store.loadConfig());
    const secrets = await store.loadSecrets();
    const selectedVaultId = config.selectedVaultId;
    const scoped = selectedVaultId ? secrets.scopedVaults?.[selectedVaultId] : undefined;
    const accessMode = selectedVaultId && (secrets.vaultKeys[selectedVaultId] || secrets.vaultKeyrings?.[selectedVaultId]) ? "full" : scoped ? "scoped" : "none";
    const data = {
      authenticated: Boolean(secrets.token),
      selectedVaultId: selectedVaultId ?? null,
      accessMode,
      namespaces: scoped?.namespaces ?? [],
      expiresAt: scoped?.expiresAt ?? null,
      mappings: config.mappings,
      apiUrl: config.apiUrl,
    };
    emit(io, program, data, `${data.authenticated ? "authenticated" : "not authenticated"}; ${config.mappings.length} mappings; vault ${data.selectedVaultId ?? "not selected"}`);
  });
  program.command("doctor").action(async () => {
    const config = normalizeConfig(await store.loadConfig());
    const secrets = await store.loadSecrets();
    const git = await promisify(execFile)("git", ["--version"]).then(() => true, () => false);
    const checks = { config: true, authenticated: Boolean(secrets.token), vaultKey: Boolean(config.selectedVaultId && (secrets.vaultKeys[config.selectedVaultId] || secrets.vaultKeyrings?.[config.selectedVaultId] || secrets.scopedVaults?.[config.selectedVaultId])), git, mappings: config.mappings.length };
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
  config.sessionBindings ??= {};
  config.runtime ??= { harnesses: {} };
  config.runtime.harnesses ??= {};
  return config;
}

async function isGitWorkingTree(path: string): Promise<boolean> {
  return promisify(execFile)("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" })
    .then(({ stdout }) => stdout.trim() === "true", () => false);
}

function parseDropMode(value: string): RootMapping["mode"] {
  if (value === "two-way" || value === "publish" || value === "consume" || value === "append") return value;
  throw new StatecaseUsageError("Drop mode must be two-way, publish, consume, or append", 2);
}

async function dropLocalState(path: string): Promise<"ready" | "missing" | "not-directory"> {
  try {
    return (await lstat(path)).isDirectory() ? "ready" : "not-directory";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
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

function isAmbiguousRemoteMutation(error: unknown): boolean {
  return !(error instanceof RemoteError) || error.status === 0 || error.status >= 500 || error.code === "INVALID_RESPONSE";
}

async function reconcileVaultKeyRotation(input: {
  client: StatecaseClient;
  vaultId: string;
  expectedEpoch: number;
  newEpoch: number;
  newKey: Uint8Array;
  deviceId: string;
  deviceExchange: { publicKey: string; privateKey: string };
}): Promise<"committed" | "not-committed" | "unknown"> {
  try {
    const recipients = await input.client.vaultKeyRecipients(input.vaultId);
    // A read of the old epoch cannot prove that an in-flight POST will not
    // commit later. Preserve recovery material until a committed key is known.
    if (recipients.keyEpoch < input.newEpoch) return "unknown";
    const history = await input.client.vaultKeyEnvelopes(input.vaultId, input.expectedEpoch);
    const current = history.envelopes.find((item) => item.keyEpoch === input.newEpoch);
    if (!current) return "unknown";
    const opened = await openVaultKeyEnvelope({
      envelope: current.envelope,
      expectedVaultId: input.vaultId,
      expectedKeyEpoch: input.newEpoch,
      expectedDeviceId: input.deviceId,
      recipientPublicKey: input.deviceExchange.publicKey,
      recipientPrivateKey: input.deviceExchange.privateKey,
    });
    try {
      return opened.byteLength === input.newKey.byteLength && timingSafeEqual(opened, input.newKey)
        ? "committed"
        : "not-committed";
    } finally {
      opened.fill(0);
    }
  } catch {
    return "unknown";
  }
}

async function syncAccess(
  store: ConfigStore,
  config: LocalConfig,
  secrets: LocalSecrets,
  client: StatecaseClient,
  vaultId: string,
): Promise<Buffer | VaultKeyring | ScopedVaultKeys> {
  if (secrets.vaultKeyrings?.[vaultId] || secrets.vaultKeys[vaultId]) {
    const keyring = decodeVaultKeyring(secrets, vaultId);
    if (!config.deviceId || !secrets.deviceExchange) return keyring;
    return refreshVaultKeyring({
      keyring, vaultId, deviceId: config.deviceId, deviceExchange: secrets.deviceExchange,
      readHistory: () => client.vaultKeyEnvelopes(vaultId, keyring.currentEpoch),
      persist: async (current) => {
        const next = {
          ...secrets,
          vaultKeyrings: { ...secrets.vaultKeyrings, [vaultId]: encodeVaultKeyring(current) },
          vaultKeys: { ...secrets.vaultKeys, [vaultId]: Buffer.from(current.keys[current.currentEpoch]!).toString("base64url") },
        };
        await store.saveSecrets(next);
        Object.assign(secrets, next);
      },
    });
  }
  const scoped = secrets.scopedVaults?.[vaultId];
  if (!scoped) throw new StatecaseUsageError("selected vault key is unavailable", 2);
  return scoped;
}

function wipeSyncAccess(access: Buffer | VaultKeyring | ScopedVaultKeys): void {
  if (access instanceof Uint8Array) access.fill(0);
  else if ("currentEpoch" in access) wipeVaultKeyring(access);
}

function parseCsv(value: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) throw new StatecaseUsageError("values must be unique and non-empty", 2);
  return values;
}

function parseCapabilityActions(value: string): Array<"read" | "append"> {
  const values = parseCsv(value);
  if (values.some((item) => item !== "read" && item !== "append")) throw new StatecaseUsageError("--actions supports read or read,append", 2);
  if (values.includes("append") && !values.includes("read")) throw new StatecaseUsageError("append capability also requires read", 2);
  return values as Array<"read" | "append">;
}

async function writeProtectedBootstrapFile(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new StatecaseUsageError("bootstrap output already exists", 2);
      throw error;
    });
  await chmod(path, 0o600);
}

async function readBootstrapTokenFile(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new StatecaseUsageError("bootstrap token path must be a regular file", 2);
  if (metadata.size > 1024) throw new StatecaseUsageError("bootstrap token file is too large", 2);
  return (await readFile(path, "utf8")).trim();
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

if (await isMainModule()) {
  process.exitCode = await runCli();
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  const [modulePath, entrypoint] = await Promise.all([
    realpath(fileURLToPath(import.meta.url)),
    realpath(process.argv[1]).catch(() => resolve(process.argv[1]!)),
  ]);
  return modulePath === entrypoint;
}
