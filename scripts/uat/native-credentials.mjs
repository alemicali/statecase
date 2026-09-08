// AU-012/AU-013/CR-011: a real Secret Service in a private bus and fresh home.
// Never connect to the caller's session bus, keyring, harness roots or profile.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
assert.equal(process.platform, "linux");
if (process.argv[2] === "--private-bus") {
  await inside(process.argv[3], process.argv[4]);
} else {
  assert.equal(process.env.STATECASE_UAT_CONFIRM, "isolated-native-credentials");
  const cli = await realpath(resolve(process.env.STATECASE_UAT_CLI ?? "apps/cli/dist/bin.js"));
  const root = await mkdtemp("/tmp/statecase-native-credentials-");
  const env = environment(root);
  let evidence;
  try {
    await Promise.all([env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_RUNTIME_DIR, env.STATECASE_HOME]
      .map((path) => mkdir(path, { mode: 0o700 })));
    // No service directories or activation helpers: losing our explicitly
    // spawned keyring cannot silently start a different daemon.
    const config = join(root, "bus.conf");
    await writeFile(config, `<busconfig><type>session</type><listen>unix:path=${root}/bus</listen><auth>EXTERNAL</auth>
<policy context="default"><allow user="*"/><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>`, { flag: "wx", mode: 0o600 });
    const result = await execute("/usr/bin/dbus-run-session", ["--config-file", config, "--", process.execPath, script, "--private-bus", root, cli],
      { env, cwd: root, timeout: 90_000, detached: true });
    assert.equal(result.code, 0, "isolated native credential UAT failed; raw child diagnostics withheld");
    evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.result, "pass");
  } finally {
    await rm(root, { recursive: true, force: true });
    await assert.rejects(stat(root), { code: "ENOENT" });
  }
  console.log(JSON.stringify({ ...evidence, fixtureCleanup: true }));
}

function environment(root) {
  return { PATH: "/usr/bin:/bin", HOME: join(root, "home"), STATECASE_HOME: join(root, "profile"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_RUNTIME_DIR: join(root, "run"),
    CODEX_HOME: join(root, "codex-unused"), CODEX_SQLITE_HOME: join(root, "codex-sqlite-unused"),
    CLAUDE_CONFIG_DIR: join(root, "claude-unused"), LANG: "C.UTF-8" };
}

async function inside(root, cli) {
  assert.match(root, /^\/tmp\/statecase-native-credentials-[A-Za-z0-9]{6}$/u);
  assert.equal(await realpath(root), root); assert.equal((await stat(root)).mode & 0o777, 0o700);
  const address = process.env.DBUS_SESSION_BUS_ADDRESS;
  assert.ok(address === `unix:path=${root}/bus` || address?.startsWith(`unix:path=${root}/bus,guid=`));
  const env = { ...environment(root), DBUS_SESSION_BUS_ADDRESS: address };
  for (const name of ["HOME", "STATECASE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"]) assert.equal(process.env[name], env[name]);
  const credentials = join(env.STATECASE_HOME, "credentials.json");
  const token = randomBytes(32).toString("base64url"), vaultKey = randomBytes(32).toString("base64url");
  const password = randomBytes(32).toString("base64url");
  await writeFile(credentials, JSON.stringify({ version: 1, token, vaultKeys: { vlt_native_fixture: vaultKey } }), { mode: 0o600, flag: "wx" });
  await writeFile(join(env.STATECASE_HOME, "config.json"), JSON.stringify({ version: 1, apiUrl: "http://127.0.0.1:1", mappings: [], workspaces: [], applied: {} }), { mode: 0o600, flag: "wx" });
  const original = await readFile(credentials);
  const command = async (...args) => {
    const result = await execute(process.execPath, [cli, "--json", ...args], { env, cwd: root, timeout: 15_000 });
    for (const canary of [token, vaultKey, password]) assert.ok(!`${result.stdout}\n${result.stderr}`.includes(canary), "secret appeared in CLI diagnostics");
    return { code: result.code, data: JSON.parse(result.stdout.trim() || "null") };
  };
  assert.equal((await command("credentials", "protect", "--dry-run")).code, 0);
  assert.deepEqual(await readFile(credentials), original);
  assert.deepEqual(await readdir(env.XDG_DATA_HOME), []);
  assert.equal((await command("credentials", "protect", "--yes")).code, 7);
  assert.deepEqual(await readFile(credentials), original);
  let daemon;
  const stop = async () => {
    if (!daemon) return;
    const child = daemon; daemon = undefined;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise((accept) => {
      if (child.exitCode !== null || child.signalCode !== null) return accept();
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("exit", () => { clearTimeout(timer); accept(); });
    });
  };
  const start = async () => {
    daemon = spawn("/usr/bin/gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets", "--control-directory", join(env.XDG_RUNTIME_DIR, "keyring")],
      { env, cwd: root, stdio: ["pipe", "ignore", "ignore"] });
    let spawnFailed = false; daemon.on("error", () => { spawnFailed = true; });
    daemon.stdin.on("error", () => undefined); daemon.stdin.end(password);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !spawnFailed && daemon.exitCode === null && daemon.signalCode === null) {
      const probe = await execute("/usr/bin/dbus-send", ["--session", "--print-reply", "--reply-timeout=1000", "--dest=org.freedesktop.DBus",
        "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", "string:org.freedesktop.secrets"], { env, timeout: 2000 });
      if (probe.code === 0 && probe.stdout.includes("boolean true")) return;
      await new Promise((accept) => setTimeout(accept, 100));
    }
    throw new Error("isolated Secret Service did not become ready");
  };
  try {
    await start();
    assert.equal((await command("credentials", "protect", "--yes")).data?.changed, true);
    const encrypted = await readFile(credentials, "utf8");
    assert.equal(JSON.parse(encrypted).version, 2); assert.equal((await stat(credentials)).mode & 0o777, 0o600);
    for (const canary of [token, vaultKey, password]) assert.ok(!encrypted.includes(canary), "plaintext credential in protected file");
    assert.equal((await command("vault", "select", "vlt_native_fixture")).code, 0);
    assert.equal((await command("credentials", "protect", "--yes")).data?.changed, false);
    const lock = await execute("/usr/bin/dbus-send", ["--session", "--print-reply", "--reply-timeout=2000", "--dest=org.freedesktop.secrets",
      "/org/freedesktop/secrets", "org.freedesktop.Secret.Service.Lock", "array:objpath:/org/freedesktop/secrets/collection/login"], { env, timeout: 3000 });
    assert.equal(lock.code, 0, "failed to lock the isolated fixture collection");
    const locked = await execute("/usr/bin/dbus-send", ["--session", "--print-reply", "--reply-timeout=2000", "--dest=org.freedesktop.secrets",
      "/org/freedesktop/secrets/collection/login", "org.freedesktop.DBus.Properties.Get", "string:org.freedesktop.Secret.Collection", "string:Locked"], { env, timeout: 3000 });
    assert.equal(locked.code, 0); assert.ok(locked.stdout.includes("boolean true"));
    assert.equal((await command("logout")).code, 7);
    assert.equal(await readFile(credentials, "utf8"), encrypted);
    await stop();
    assert.equal((await command("credentials", "status")).data?.protected, true);
    assert.equal((await command("logout")).code, 7);
    assert.equal(await readFile(credentials, "utf8"), encrypted);
    await start();
    assert.equal((await command("vault", "select", "vlt_native_fixture")).code, 0);
    assert.equal((await command("logout")).code, 0);
    const updated = await readFile(credentials, "utf8");
    assert.equal(JSON.parse(updated).version, 2); assert.notEqual(updated, encrypted);
    assert.equal((await command("vault", "select", "vlt_native_fixture")).code, 0);
    assert.ok((await readdir(join(env.XDG_DATA_HOME, "keyrings"))).includes("login.keyring"));
    console.log(JSON.stringify({ result: "pass", backend: "secret-service", node: process.version,
      privateBus: true, explicitMigration: true, unavailableStorePreservesFile: true,
      lockedStorePreservesFile: true, keyringProcessRestart: true, encryptedLogout: true, persistentLoginKeyring: true,
      boundary: "CLI artifact, isolated native store; no cloud, OS reboot, interactive unlock UI, macOS or independent security review" }));
  } finally { await stop(); }
}

function execute(file, args, options) {
  return new Promise((accept) => {
    const child = execFile(file, args, { encoding: "utf8", maxBuffer: 128 * 1024, killSignal: "SIGKILL", ...options }, (error, stdout, stderr) => {
      if (options.detached) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (failure) { if (failure.code !== "ESRCH") return accept({ code: 1, stdout: "", stderr: "process group cleanup failed" }); }
      }
      accept({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}
