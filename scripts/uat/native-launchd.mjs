import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = process.env.STATECASE_UAT_ROOT;
const artifact = process.env.STATECASE_UAT_CLI;
assert.equal(process.env.STATECASE_UAT_CONFIRM, "temporary-native-service");
assert.equal(process.platform, "darwin");
assert.ok(root && artifact && isAbsolute(root) && resolve(root) === root);
assert.ok(root.split("/").filter(Boolean).length >= 2);
const target = `gui/${process.getuid()}/com.statecase.daemon`;
assert.equal(await inspect(), undefined, "refusing to interfere with an existing Statecase service");
const home = join(root, "user-home");
const profile = join(root, "profile");
const drop = join(root, "drop 100% ${UNSET}");
await Promise.all([home, profile, drop].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
await writeFile(join(profile, "config.json"), JSON.stringify({ version: 1, apiUrl: "http://127.0.0.1:1", mappings: [
  { id: "drop_native", namespace: "drop:drop_native", kind: "drop", path: drop, mode: "two-way", name: "Native service fixture" },
], workspaces: [], applied: {} }), { mode: 0o600, flag: "wx" });
const env = { PATH: process.env.PATH, HOME: home, STATECASE_HOME: profile,
  STATECASE_KEYCHAIN_PATH: join(root, "unused-fixture.keychain-db"),
  CODEX_HOME: join(home, "codex"), CODEX_SQLITE_HOME: join(home, "codex-sqlite"), CLAUDE_CONFIG_DIR: join(home, "claude") };
let definition;
try {
  await command(env, "profile", "upgrade", "--yes");
  definition = (await command(env, "daemon", "install", "--no-start")).path;
  assert.equal(definition, join(home, "Library", "LaunchAgents", "com.statecase.daemon.plist"));
  const contents = await readFile(definition, "utf8");
  assert.ok(contents.includes(`<string>${process.execPath}</string>`));
  assert.ok(contents.includes(`<key>STATECASE_KEYCHAIN_PATH</key>\n    <string>${env.STATECASE_KEYCHAIN_PATH}</string>`));
  await command(env, "daemon", "start");
  const initial = await waitForStatus((status) => status?.running && status.roots === 1);
  await assertOwned();
  assert.ok((await inspect()).includes(`STATECASE_KEYCHAIN_PATH => ${env.STATECASE_KEYCHAIN_PATH}`));
  assert.equal(initial.queued, true);
  const socket = await stat(join(profile, "daemon.sock"));
  assert.ok(socket.isSocket());
  assert.equal(socket.mode & 0o777, 0o600);
  assert.equal((await stat(profile)).mode & 0o777, 0o700);
  await command(env, "daemon", "start");
  assert.equal((await command(env, "daemon", "status")).pid, initial.pid);
  await assert.rejects(command({ ...env, STATECASE_HOME: join(root, "other-profile") }, "daemon", "stop"));
  await assert.rejects(command(env, "daemon", "foreground", "--once"));
  assert.equal((await command(env, "daemon", "status")).pid, initial.pid);
  await writeFile(join(drop, "changed.txt"), "filesystem notification fixture\n");
  await waitForStatus((status) => status?.lastTrigger === "filesystem");
  await assertOwned();
  await manager("kill", "SIGKILL", target);
  const recovered = await waitForStatus((status) => status?.running && status.pid !== initial.pid);
  await command(env, "daemon", "stop");
  await waitForStatus((status) => status === undefined);
  assert.equal(await inspect(), undefined);
  await assert.rejects(readFile(join(profile, "daemon.lock")), { code: "ENOENT" });
  await command(env, "daemon", "stop");
  await command(env, "daemon", "start");
  await waitForStatus((status) => status?.running && status.pid !== recovered.pid);
} finally {
  if (definition) {
    if (await inspect() !== undefined) await assertOwned();
    await command(env, "daemon", "uninstall", "--yes");
  }
  assert.equal(await inspect(), undefined);
}
console.log(JSON.stringify({ result: "pass", nativeManager: "launchd-gui", node: process.version,
  pinnedNodeRuntime: true, privateIpc: true, duplicateWriterDenied: true, profileIsolation: true,
  selectedKeychainEnvironment: true,
  filesystemEvents: true, sigkillRecovery: true, idempotentStartStop: true, cleanupVerified: true,
  boundary: "isolated unauthenticated fixture; no remote sync or machine reboot claimed" }));

async function inspect() {
  try { return (await execute("launchctl", ["print", target], { encoding: "utf8", timeout: 20_000, maxBuffer: 256 * 1024 })).stdout; }
  catch (error) {
    if (error.code === 113 && typeof error.stderr === "string" && error.stderr.includes('Could not find service "com.statecase.daemon"')) return undefined;
    throw new Error(`launchd inspection failed (code ${error.code}); raw diagnostics withheld`);
  }
}
async function manager(...args) {
  try { await execute("launchctl", args, { encoding: "utf8", timeout: 20_000 }); }
  catch { throw new Error("native launchd command failed; raw diagnostics withheld"); }
}
async function assertOwned() {
  const printed = await inspect();
  const paths = [...(printed ?? "").matchAll(/^\tpath = (.+)$/gm)];
  assert.equal(paths.length, 1, "unrecognized launchd ownership response");
  assert.equal(await realpath(paths[0][1]), await realpath(definition), "launchd ownership changed");
}
async function command(commandEnv, ...args) {
  try {
    const result = await execute(process.execPath, [artifact, "--json", ...args], { env: commandEnv, encoding: "utf8", timeout: 20_000 });
    return JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1));
  } catch { throw new Error(`fixture CLI command failed: ${args.slice(0, 2).join(" ")}; raw diagnostics withheld`); }
}
async function waitForStatus(predicate) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const status = await command(env, "daemon", "status").catch(() => undefined);
    if (predicate(status)) return status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("native launchd service did not reach expected state");
}
