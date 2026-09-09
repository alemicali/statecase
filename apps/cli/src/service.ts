import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { promisify } from "node:util";

const MARKER = "statecase-service-v1";

export interface ServiceSource {
  platform: "linux" | "darwin";
  home: string;
  statecaseExecutable: string;
  nodeExecutable?: string;
  statecaseHome: string;
  keychainPath?: string;
  roots: readonly string[];
  uid?: number;
}

export interface ServiceDefinition {
  source: ServiceSource;
  path: string;
  contents: string;
  enableCommands: Array<[string, string[]]>;
  disableCommands: Array<[string, string[]]>;
}

export type ServiceCommandRunner = (file: string, args: readonly string[]) => Promise<{ stdout: string }>;
export type ServiceAction = "enable" | "disable" | "start" | "stop";
const runManager: ServiceCommandRunner = (file, args) => promisify(execFile)(file, [...args], {
  encoding: "utf8", timeout: 20_000, maxBuffer: 256 * 1024,
});

export function serviceDefinition(source: ServiceSource): ServiceDefinition {
  const nodeExecutable = source.nodeExecutable ?? process.execPath;
  const keychainPath = source.platform === "darwin" ? source.keychainPath : undefined;
  if (keychainPath !== undefined && (!posix.isAbsolute(keychainPath) || Buffer.byteLength(keychainPath) > 2048)) {
    throw new Error("selected keychain must be a bounded absolute path");
  }
  for (const path of [source.home, source.statecaseExecutable, nodeExecutable, source.statecaseHome, ...source.roots, ...(keychainPath === undefined ? [] : [keychainPath])]) {
    if ([...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new Error("service paths must not contain control characters");
    }
  }
  const normalized: ServiceSource = {
    ...source,
    home: resolve(source.home),
    statecaseExecutable: resolve(source.statecaseExecutable),
    nodeExecutable: resolve(nodeExecutable),
    keychainPath,
    statecaseHome: resolve(source.statecaseHome),
    roots: [...new Set(source.roots.map((root) => resolve(root)))],
  };
  if (source.platform === "linux") return systemdDefinition(normalized);
  if (source.platform === "darwin") return launchdDefinition(normalized);
  throw new Error("native daemon services are supported on Linux and macOS");
}

export async function installServiceDefinition(definition: ServiceDefinition): Promise<{ created: boolean; path: string }> {
  const existing = await optionalContents(definition.path);
  if (existing !== undefined) {
    if (!owned(existing)) throw new Error(`refusing to replace non-Statecase service definition: ${definition.path}`);
    assertProfile(definition, existing);
    if (existing === definition.contents) return { created: false, path: definition.path };
  }
  await mkdir(dirname(definition.path), { recursive: true, mode: 0o700 });
  await mkdir(join(definition.source.statecaseHome, "logs"), { recursive: true, mode: 0o700 });
  const temporary = `${definition.path}.statecase-${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(definition.contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, definition.path).catch(async (error) => {
    await rm(temporary, { force: true });
    throw error;
  });
  await chmod(definition.path, 0o600);
  return { created: true, path: definition.path };
}

export async function removeServiceDefinition(definition: ServiceDefinition): Promise<boolean> {
  const existing = await optionalContents(definition.path);
  if (existing === undefined) return false;
  if (!owned(existing)) throw new Error(`refusing to remove non-Statecase service definition: ${definition.path}`);
  assertProfile(definition, existing);
  await rm(definition.path);
  return true;
}

export async function activateService(
  definition: ServiceDefinition,
  action: ServiceAction,
  runner: ServiceCommandRunner = runManager,
): Promise<void> {
  const existing = await optionalContents(definition.path);
  if (existing === undefined) throw new Error("Statecase service is not installed; run daemon install first");
  if (!owned(existing)) throw new Error("refusing to control non-Statecase service definition");
  assertProfile(definition, existing);
  const commands: Array<[string, string[]]> = [];
  if (definition.source.platform === "linux") {
    const loaded = (await manager(runner, "systemctl", ["--user", "show", "statecase.service", "--property=FragmentPath", "--value"])).trim();
    if (loaded) await assertLoadedPath(definition, loaded);
    if (action === "enable") commands.push(...definition.enableCommands);
    else if (action === "disable") commands.push(...definition.disableCommands);
    else {
      if (action === "start") commands.push(["systemctl", ["--user", "daemon-reload"]]);
      if (loaded || action === "start") commands.push(["systemctl", ["--user", action, "statecase.service"]]);
    }
  } else {
    const domain = definition.enableCommands[0]![1][1]!;
    const target = `${domain}/com.statecase.daemon`;
    let loaded = false;
    let printed: string | undefined;
    try {
      printed = (await runner("launchctl", ["print", target])).stdout;
    } catch (error) {
      // Only an explicit missing-service response means stopped. Permission,
      // missing domain, timeout, and other failures must not trigger bootstrap.
      const failure = error as { code?: unknown; stderr?: unknown };
      if (failure.code !== 113 || typeof failure.stderr !== "string" ||
          !failure.stderr.includes('Could not find service "com.statecase.daemon"')) {
        throw new Error("native service manager inspection failed");
      }
    }
    if (printed !== undefined) {
      const paths = [...printed.matchAll(/^\tpath = (.+)$/gm)];
      if (paths.length !== 1) throw new Error("unrecognized native service manager response; refusing service control");
      await assertLoadedPath(definition, paths[0]![1]!);
      loaded = true;
    }
    if (action === "enable" || action === "start") {
      commands.push(["launchctl", ["enable", target]]);
      if (!loaded) commands.push(["launchctl", ["bootstrap", domain, definition.path]]);
      // Without -k: a repeated start must not kill a healthy writer.
      commands.push(["launchctl", ["kickstart", target]]);
    } else {
      // KeepAlive would restart a killed process; bootout unloads it instead.
      if (loaded) commands.push(["launchctl", ["bootout", target]]);
      if (action === "disable") commands.push(["launchctl", ["disable", target]]);
    }
  }
  for (const [file, args] of commands) await manager(runner, file, args);
}

async function manager(runner: ServiceCommandRunner, file: string, args: string[]): Promise<string> {
  try { return (await runner(file, args)).stdout; }
  catch { throw new Error("native service manager command failed; inspect the local service manager"); }
}

async function assertLoadedPath(definition: ServiceDefinition, path: string): Promise<void> {
  if (await realpath(path) !== await realpath(definition.path)) {
    throw new Error("native manager loaded a different service definition; refusing service control");
  }
}

function assertProfile(definition: ServiceDefinition, contents: string): void {
  let matches: boolean;
  if (definition.source.platform === "linux") {
    matches = contents.includes(`Environment=${systemdQuote(`STATECASE_HOME=${definition.source.statecaseHome}`)}\n`);
  } else {
    // Accept the original environment dictionary and the extended keychain
    // form. Match the full owned shape, not a loose profile substring.
    const environments = [...contents.matchAll(/  <key>EnvironmentVariables<\/key>\n  <dict><key>STATECASE_HOME<\/key>\n    <string>([^<]*)<\/string>(?:\n    <key>STATECASE_KEYCHAIN_PATH<\/key>\n    <string>[^<]*<\/string>)?<\/dict>\n/gu)];
    matches = environments.length === 1 && environments[0]![1] === xml(definition.source.statecaseHome);
  }
  if (!matches) throw new Error("Statecase service belongs to another profile; refusing to modify it");
}

function systemdDefinition(source: ServiceSource): ServiceDefinition {
  const path = join(source.home, ".config", "systemd", "user", "statecase.service");
  const writable = [source.statecaseHome, ...source.roots].map((root) => `ReadWritePaths=${systemdQuote(root)}`);
  const contents = [
    `# ${MARKER}`,
    "[Unit]",
    "Description=Statecase agent context synchronization",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    // ':' disables systemd's own environment substitution (including ${...}
    // embedded in literal paths); this is not shell quoting.
    `ExecStart=:${systemdQuote(source.nodeExecutable!)} ${systemdQuote(source.statecaseExecutable)} daemon foreground`,
    `Environment=${systemdQuote(`STATECASE_HOME=${source.statecaseHome}`)}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "UMask=0077",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    ...writable,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return {
    source,
    path,
    contents,
    enableCommands: [
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "--now", "statecase.service"]],
    ],
    disableCommands: [
      ["systemctl", ["--user", "disable", "--now", "statecase.service"]],
      ["systemctl", ["--user", "daemon-reload"]],
    ],
  };
}

function launchdDefinition(source: ServiceSource): ServiceDefinition {
  const uid = source.uid ?? process.getuid?.();
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) throw new Error("could not determine the macOS user ID");
  const label = "com.statecase.daemon";
  const domain = `gui/${uid}`;
  const path = join(source.home, "Library", "LaunchAgents", `${label}.plist`);
  const logRoot = join(source.statecaseHome, "logs");
  const contents = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    "<plist version=\"1.0\">",
    `<dict><!-- ${MARKER} -->`,
    "  <key>Label</key>",
    `  <string>${xml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xml(source.nodeExecutable!)}</string>`,
    `    <string>${xml(source.statecaseExecutable)}</string>`,
    "    <string>daemon</string>",
    "    <string>foreground</string>",
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict><key>STATECASE_HOME</key>",
    `    <string>${xml(source.statecaseHome)}</string>${source.keychainPath === undefined ? "" : `\n    <key>STATECASE_KEYCHAIN_PATH</key>\n    <string>${xml(source.keychainPath)}</string>`}</dict>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    "  <key>ThrottleInterval</key><integer>5</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(join(logRoot, "daemon.stdout.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(join(logRoot, "daemon.stderr.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  return {
    source,
    path,
    contents,
    enableCommands: [
      ["launchctl", ["bootstrap", domain, path]],
      ["launchctl", ["enable", `${domain}/${label}`]],
      ["launchctl", ["kickstart", "-k", `${domain}/${label}`]],
    ],
    disableCommands: [
      ["launchctl", ["bootout", `${domain}/${label}`]],
      ["launchctl", ["disable", `${domain}/${label}`]],
    ],
  };
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function owned(contents: string): boolean {
  return contents.includes(MARKER);
}

async function optionalContents(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`refusing unsafe service definition path: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
