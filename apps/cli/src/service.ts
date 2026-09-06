import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const MARKER = "statecase-service-v1";

export interface ServiceSource {
  platform: "linux" | "darwin";
  home: string;
  statecaseExecutable: string;
  statecaseHome: string;
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

type CommandRunner = (file: string, args: readonly string[]) => Promise<unknown>;

export function serviceDefinition(source: ServiceSource): ServiceDefinition {
  const normalized: ServiceSource = {
    ...source,
    home: resolve(source.home),
    statecaseExecutable: resolve(source.statecaseExecutable),
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
  await rm(definition.path);
  return true;
}

export async function activateService(
  definition: ServiceDefinition,
  action: "enable" | "disable",
  runner: CommandRunner = async (file, args) => promisify(execFile)(file, [...args]),
): Promise<void> {
  const commands = action === "enable" ? definition.enableCommands : definition.disableCommands;
  for (const [file, args] of commands) await runner(file, args);
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
    `ExecStart=${systemdQuote(source.statecaseExecutable)} daemon foreground`,
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
    `    <string>${xml(source.statecaseExecutable)}</string>`,
    "    <string>daemon</string>",
    "    <string>foreground</string>",
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict><key>STATECASE_HOME</key>",
    `    <string>${xml(source.statecaseHome)}</string></dict>`,
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
