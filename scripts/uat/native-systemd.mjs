import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = process.env.STATECASE_UAT_ROOT;
const artifact = process.env.STATECASE_UAT_CLI;
assert.equal(process.env.STATECASE_UAT_CONFIRM, "temporary-native-service");
assert.equal(process.platform, "linux");
assert.ok(root && artifact && isAbsolute(root) && resolve(root) === root);
assert.ok(root.split("/").filter(Boolean).length >= 2 && !root.startsWith("/tmp/"), "PrivateTmp requires a persistent fixture path outside /tmp");
const unit = "statecase.service";
assert.equal((await manager("show", unit, "--property=LoadState", "--value")).trim(), "not-found", "refusing to interfere with an existing Statecase service");
const home = join(root, "user-home");
const profile = join(root, "profile");
const drop = join(root, "drop 100% ${UNSET}");
const bin = join(root, "bin 100% ${UNSET}");
await Promise.all([home, profile, drop, bin].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
const cli = join(bin, "statecase");
await symlink(resolve(artifact), cli);
await writeFile(join(profile, "config.json"), JSON.stringify({ version: 1, apiUrl: "http://127.0.0.1:1", mappings: [
  { id: "drop_native", namespace: "drop:drop_native", kind: "drop", path: drop, mode: "two-way", name: "Native service fixture" },
], workspaces: [], applied: {} }), { mode: 0o600, flag: "wx" });
const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), STATECASE_HOME: profile,
  CODEX_HOME: join(home, "codex"), CODEX_SQLITE_HOME: join(home, "codex-sqlite"), CLAUDE_CONFIG_DIR: join(home, "claude") };
let linked = false;
let definition;
try {
  const installed = await command("daemon", "install", "--no-start");
  definition = installed.path;
  assert.equal(definition, join(home, ".config", "systemd", "user", unit));
  assert.ok((await readFile(definition, "utf8")).includes(`ExecStart=:"${process.execPath}"`), "service did not pin the actual Node runtime");
  await manager("link", "--runtime", definition);
  linked = true;
  await assertOwned();
  await manager("start", unit);
  const initial = await waitForStatus((status) => status.running && status.roots === 1);
  const socket = await stat(join(profile, "daemon.sock"));
  assert.ok(socket.isSocket());
  assert.equal(socket.mode & 0o777, 0o600);
  assert.equal((await stat(profile)).mode & 0o777, 0o700);
  assert.equal(initial.queued, true, "unauthenticated fixture should remain visibly queued");
  await assert.rejects(command("daemon", "foreground", "--once"), "a second daemon acquired the profile lock");
  assert.equal((await command("daemon", "status")).pid, initial.pid);

  await writeFile(join(drop, "changed.txt"), "filesystem notification fixture\n");
  await waitForStatus((status) => status.lastTrigger === "filesystem");
  await assertOwned();
  await manager("kill", "--signal=SIGKILL", "--kill-whom=main", unit);
  const recovered = await waitForStatus((status) => status.running && status.pid !== initial.pid);
  await assertOwned();
  await manager("stop", unit);
  await assert.rejects(command("daemon", "status"));
  await assert.rejects(readFile(join(profile, "daemon.lock")), { code: "ENOENT" });
  await manager("start", unit);
  const restarted = await waitForStatus((status) => status.running && status.pid !== recovered.pid);
  assert.equal(restarted.roots, 1);
} finally {
  if (linked) {
    await assertOwned();
    await manager("stop", unit);
    await manager("disable", "--runtime", unit);
    await manager("daemon-reload");
    await manager("reset-failed", unit).catch(() => undefined);
  }
  if (definition) await command("daemon", "uninstall", "--no-stop", "--yes");
  assert.equal((await manager("show", unit, "--property=LoadState", "--value")).trim(), "not-found");
}
console.log(JSON.stringify({ result: "pass", nativeManager: "systemd-user", pinnedNodeRuntime: true,
  literalSpecialCharacterPaths: true, privateIpc: true, duplicateWriterDenied: true,
  filesystemEvents: true, sigkillRecovery: true, explicitStopStart: true, cleanupVerified: true,
  boundary: "isolated unauthenticated fixture; no remote sync or machine reboot claimed" }));

async function manager(...args) {
  return (await execute("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 20_000 })).stdout;
}
async function assertOwned() {
  // Linked units are reported at their runtime symlink, not the source file.
  const fragment = (await manager("show", unit, "--property=FragmentPath", "--value")).trim();
  assert.equal(await realpath(fragment), await realpath(definition),
    "service ownership changed; refusing further service operations");
}
async function command(...args) {
  const result = await execute(process.execPath, [cli, "--json", ...args], { env, encoding: "utf8", timeout: 20_000 });
  return JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1));
}
async function waitForStatus(predicate) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const status = await command("daemon", "status").catch(() => undefined);
    if (status && predicate(status)) return status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const state = await manager("show", unit, "--property=Result", "--property=ExecMainStatus", "--property=SubState");
  throw new Error(`native service did not reach expected state: ${state.trim()}`);
}
