import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { trackFixtureProcess, fixtureFailureSummary } from "./fixture-process.mjs";
import { contractHeaders } from "./contract.mjs";

// Local by default. Live mode requires explicit scope/cleanup configuration;
// it never grants signup access or deletes remote objects on its own.
const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const remoteApi = process.env.STATECASE_UAT_API_URL;
const nativeLinux = process.env.STATECASE_UAT_NATIVE_LINUX === "1";
const parent = process.env.STATECASE_UAT_PARENT ?? tmpdir();
const targetsPath = process.env.STATECASE_UAT_TARGETS;
if (remoteApi) {
  assert.equal(remoteApi, "https://statecase-api.hi-0e6.workers.dev");
  assert.equal(process.env.STATECASE_UAT_CONFIRM, "create-and-modify-remote-state");
  assert.match(process.env.STATECASE_UAT_EMAIL ?? "", /^statecase-background-[a-f0-9]+@example\.com$/u);
  assert.ok(targetsPath && isAbsolute(targetsPath), "explicit external cleanup-target path required");
}
if (nativeLinux) {
  assert.equal(process.platform, "linux");
  assert.ok(isAbsolute(parent) && !resolve(parent).startsWith("/tmp"), "native PrivateTmp requires a persistent fixture parent");
}
const root = await mkdtemp(join(parent, "stc-background-"));
const cli = resolve(process.env.STATECASE_UAT_CLI ?? join(repository, "apps/cli/dist/bin.js"));
const wrangler = join(repository, "node_modules/wrangler/bin/wrangler.js");
const children = [];
const proxies = [];
const env = { PATH: process.env.PATH, HOME: join(root, "user-home"), TMPDIR: join(root, "tmp"), WRANGLER_SEND_METRICS: "false",
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  CODEX_HOME: join(root, "codex"), CODEX_SQLITE_HOME: join(root, "codex-sqlite"), CLAUDE_CONFIG_DIR: join(root, "claude") };
const email = remoteApi ? process.env.STATECASE_UAT_EMAIL : "background@example.invalid";
const passphrase = randomBytes(32).toString("base64url");
const password = randomBytes(32).toString("base64url");
let apiUrl;
let vault;
let nativeDefinition;
let nativeLinked = false;
const machines = {};
let currentPhase = "setup";
try {
  if (nativeLinux) assert.equal((await manager("show", "statecase.service", "--property=LoadState", "--value")).trim(), "not-found", "refusing to interfere with existing native service");
  await mkdir(env.HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.TMPDIR, { mode: 0o700 });
  if (remoteApi) apiUrl = remoteApi;
  else {
    const reservation = createServer();
    await listen(reservation);
    const port = reservation.address().port;
    await close(reservation);
    apiUrl = `http://127.0.0.1:${port}`;
    const configPath = join(root, "wrangler.json");
    const base = JSON.parse(await readFile(join(repository, "apps/cloud/wrangler.jsonc"), "utf8"));
    await writeFile(configPath, JSON.stringify({
      name: "statecase-background-uat", main: join(repository, "apps/cloud/src/index.ts"),
      compatibility_date: base.compatibility_date, compatibility_flags: base.compatibility_flags,
      vars: { STATECASE_ENV: "test", STATECASE_ALLOWED_EMAILS: email, BETTER_AUTH_URL: apiUrl,
        BETTER_AUTH_SECRET: randomBytes(32).toString("base64url") },
      d1_databases: [{ binding: "DB", database_name: "statecase-background-uat",
        database_id: "00000000-0000-0000-0000-000000000001", migrations_dir: join(repository, "apps/cloud/migrations") }],
      r2_buckets: [{ binding: "BLOBS", bucket_name: "statecase-background-uat" }],
      durable_objects: base.durable_objects, migrations: base.migrations,
    }), { mode: 0o600, flag: "wx" });
    await tool(wrangler, ["d1", "migrations", "apply", "statecase-background-uat", "--local", "--config", configPath, "--persist-to", join(root, "cloud")], env);
    const backend = child(wrangler, ["dev", "--local", "--config", configPath, "--persist-to", join(root, "cloud"),
      "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--log-level", "error"], env);
    await eventually(async () => {
      assertLive(backend);
      return (await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(1000) })).ok;
    }, "local backend readiness", 30_000);
  }
  const signup = await request("/api/auth/sign-up/email", { method: "POST", body: { email, name: "Background UAT", password } });
  assert.equal(signup.status, 200, "synthetic signup failed");
  const cookie = signup.headers.get("set-cookie");
  assert.ok(cookie);
  for (const name of ["a", "b"]) {
    const proxy = await networkProxy(apiUrl);
    proxies.push(proxy);
    const home = join(root, name);
    const drop = join(root, `files-${name}`);
    await mkdir(drop, { mode: 0o700 });
    const machine = machines[name] = { home, drop, proxy, env: { ...env, STATECASE_HOME: home,
      STATECASE_API_URL: proxy.url, STATECASE_RECOVERY_PASSPHRASE: passphrase } };
    machine.token = await authorize(cookie);
    await command(name, ["login", "--non-interactive", "--device-name", `background-${name}`], { STATECASE_TOKEN: machine.token });
  }
  const kit = join(root, "recovery.json");
  vault = await command("a", ["vault", "create", "Background UAT", "--recovery-file", kit]);
  if (remoteApi) await writeFile(targetsPath, JSON.stringify({ email, vaultId: vault.id }), { mode: 0o600, flag: "wx" });
  await command("b", ["vault", "join", vault.id, "--recovery-file", kit]);
  await writeFile(join(machines.a.drop, "context.txt"), "initial\n");
  const drop = await command("a", ["drop", "add", machines.a.drop, "--name", "Background context"]);
  await command("a", ["push"]);
  await command("b", ["drop", "map", drop.id, machines.b.drop]);
  await command("b", ["pull"]);
  for (const name of ["a", "b"]) {
    if (nativeLinux && name === "a") {
      nativeDefinition = (await command(name, ["daemon", "install", "--no-start"])).path;
      await manager("link", "--runtime", nativeDefinition);
      nativeLinked = true;
      await assertNativeOwned();
      machines[name].native = true;
      await command(name, ["daemon", "start"]);
    } else machines[name].daemon = child(cli, ["daemon", "foreground"], machines[name].env);
    await eventually(async () => (await status(name)).queued === false, `${name} authenticated daemon startup`);
  }
  phase("authenticated-startup");

  await writeFile(join(machines.a.drop, "context.txt"), "written by a\n");
  await content("b", "context.txt", "written by a\n");
  await writeFile(join(machines.b.drop, "context.txt"), "written by b\n");
  await content("a", "context.txt", "written by b\n");
  phase("automatic-bidirectional-transfer");

  const beforeUpload = await head();
  machines.a.proxy.holdUpload = true;
  await writeFile(join(machines.a.drop, "interrupted.txt"), "upload interrupted before remote acceptance\n");
  await eventually(async () => machines.a.proxy.uploadBlocked === true, "in-flight encrypted upload");
  const interrupted = journal("a").filter((operation) => operation.state === "running");
  assert.ok(interrupted.length > 0, "upload began without a durable running operation");
  assert.equal(await head(), beforeUpload, "held upload advanced the remote head");
  machines.a.proxy.offline = true;
  await crashAndRestart("a");
  machines.a.proxy.holdUpload = false;
  await writeFile(join(machines.a.drop, "offline.txt"), "offline a\n");
  await eventually(async () => (await status("a")).queued === true, "visible offline journal");
  for (const operation of interrupted) assert.ok(journal("a").some((row) => row.id === operation.id), "restart discarded the interrupted operation");
  phase("interrupted-upload-journal-retained");
  await writeFile(join(machines.b.drop, "online.txt"), "online b\n");
  await eventually(async () => await head() !== beforeUpload, "online peer publishes while a remains offline");
  await crashAndRestart("a");
  await eventually(async () => (await status("a")).queued === true, "offline process restart retains queued work");
  machines.a.proxy.offline = false;
  await content("b", "interrupted.txt", "upload interrupted before remote acceptance\n");
  await content("b", "offline.txt", "offline a\n");
  await content("a", "online.txt", "online b\n");
  for (const name of ["a", "b"]) await eventually(async () => (await status(name)).queued === false, `${name} recovered online`);
  await eventually(async () => interrupted.every((operation) => journal("a").some((row) => row.id === operation.id && row.state === "committed")), "expired interrupted lease replayed and committed");
  phase("offline-crash-recovery-and-disjoint-convergence");

  await rm(join(machines.a.drop, "offline.txt"));
  await eventually(async () => {
    try { await readFile(join(machines.b.drop, "offline.txt")); return false; }
    catch (error) { if (error.code === "ENOENT") return true; throw error; }
  }, "automatic deletion propagation");
  const before = await head();
  currentPhase = "idle";
  // Cover at least one maximum reconciliation and two remote polls.
  await new Promise((resolveWait) => setTimeout(resolveWait, 45_000));
  assert.equal(await head(), before, "idle daemons produced spurious revisions");
  phase("deletion-and-idle-noop");
  for (const name of ["a", "b"]) assert.equal((await status(name)).running, true);
} catch (error) {
  console.error(JSON.stringify(fixtureFailureSummary(error, currentPhase, children)));
  throw new Error("background UAT failed; see redacted process diagnostics");
} finally {
  try {
    if (nativeLinked) {
      await assertNativeOwned();
      await command("a", ["daemon", "stop"]);
      await manager("disable", "--runtime", "statecase.service");
      await manager("daemon-reload");
      await command("a", ["daemon", "uninstall", "--no-stop", "--yes"]);
      assert.equal((await manager("show", "statecase.service", "--property=LoadState", "--value")).trim(), "not-found");
      nativeLinked = false;
    }
  } finally {
    await Promise.all(children.map((entry) => stop(entry)));
    await Promise.all(proxies.map((proxy) => close(proxy.server)));
    // Keep the exact fixture available for recovery if ownership/cleanup failed.
    if (!nativeLinked) await rm(root, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ result: "pass", runtime: nativeLinux ? "systemd-user-plus-cli-peer" : "two-authenticated-cli-daemons", backend: remoteApi ? "live-cloudflare" : "local-workerd-d1-r2",
  automaticBidirectionalTransfer: true, interruptedUploadJournalReplay: true, offlineCrashRecovery: true, disjointConvergence: true,
  deletionPropagation: true, idleNoop: true, cleanupVerified: true,
  remoteCleanupRequired: Boolean(remoteApi),
  boundary: "two isolated installations on one host; no real harness, separate physical peer, or machine reboot qualified" }));

function phase(name) { currentPhase = name; console.log(JSON.stringify({ phase: name, result: "pass" })); }
function child(entrypoint, args, childEnv) {
  const processHandle = spawn(process.execPath, [entrypoint, ...args], { env: childEnv, cwd: repository, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const tracked = trackFixtureProcess(processHandle, entrypoint === wrangler ? "backend" : "daemon");
  children.push(tracked);
  return tracked;
}
function assertLive(entry) { assert.equal(entry.done, false, "owned fixture process exited unexpectedly"); }
async function stop(entry, signal = "SIGTERM") {
  entry.expectedStop = true;
  if (entry.done) return;
  process.kill(-entry.process.pid, signal);
  const deadline = Date.now() + 10_000;
  while (!entry.done && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  if (!entry.done) process.kill(-entry.process.pid, "SIGKILL");
  await entry.exited;
}
async function tool(entrypoint, args, commandEnv) {
  try { return (await execute(process.execPath, [entrypoint, ...args], { env: commandEnv, cwd: repository,
    encoding: "utf8", timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
  catch (error) { throw new Error(`fixture command ${args.slice(0, 2).join(" ")} failed (code ${error.code}); diagnostics withheld`); }
}
async function command(name, args, extraEnv = {}) {
  return JSON.parse((await tool(cli, ["--json", ...args], { ...machines[name].env, ...extraEnv })).trim().split("\n").at(-1));
}
async function status(name) { if (!machines[name].native) assertLive(machines[name].daemon); return command(name, ["daemon", "status"]); }
async function manager(...args) {
  try { return (await execute("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 20_000 })).stdout; }
  catch { throw new Error("fixture native service operation failed; diagnostics withheld"); }
}
async function assertNativeOwned() {
  const fragment = (await manager("show", "statecase.service", "--property=FragmentPath", "--value")).trim();
  assert.equal(await realpath(fragment), await realpath(nativeDefinition), "native fixture ownership changed");
}
async function crashAndRestart(name) {
  if (machines[name].native) {
    const previousPid = (await status(name)).pid;
    await assertNativeOwned();
    await manager("kill", "--signal=SIGKILL", "--kill-whom=main", "statecase.service");
    await eventually(async () => (await status(name)).pid !== previousPid, "native automatic restart", 30_000);
  } else {
    await stop(machines[name].daemon, "SIGKILL");
    machines[name].daemon = child(cli, ["daemon", "foreground"], machines[name].env);
  }
}
async function content(name, file, expected) {
  await eventually(async () => (await readFile(join(machines[name].drop, file), "utf8")) === expected, `${name} receives ${file}`);
}
async function head() {
  const result = await request(`/v1/vaults/${vault.id}/namespaces`, { headers: { authorization: `Bearer ${machines.a.token}` } });
  assert.equal(result.status, 200);
  assert.equal(typeof result.json.revisionId, "string");
  return result.json.revisionId;
}
function journal(name) {
  const database = new Database(join(machines[name].home, "state.db"), { readonly: true, fileMustExist: true });
  try { return database.prepare("SELECT id, state FROM operations").all(); }
  finally { database.close(); }
}
async function eventually(predicate, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const entry of children) if (!entry.expectedStop) assertLive(entry);
    if (await predicate().catch(() => false)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`background UAT timed out: ${label}`);
}
async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, { method: options.method,
    headers: { ...contractHeaders, ...(options.body ? { "content-type": "application/json", origin: apiUrl } : {}), ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined, signal: AbortSignal.timeout(15_000) });
  const json = await response.json();
  return { status: response.status, headers: response.headers, json };
}
async function authorize(cookie) {
  const issued = await request("/api/auth/device/code", { method: "POST", body: { client_id: "statecase-cli", scope: "sync" } });
  assert.equal(issued.status, 200);
  const checked = await request(`/api/auth/device?user_code=${encodeURIComponent(issued.json.user_code)}`, { headers: { cookie } });
  assert.equal(checked.status, 200);
  const approved = await request("/api/auth/device/approve", { method: "POST", headers: { cookie }, body: { userCode: issued.json.user_code } });
  assert.equal(approved.status, 200);
  const exchanged = await request("/api/auth/device/token", { method: "POST", body: {
    client_id: "statecase-cli", device_code: issued.json.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" } });
  assert.equal(exchanged.status, 200);
  return exchanged.json.access_token;
}
async function listen(server) { await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); }); }
async function close(server) { server.closeAllConnections(); await new Promise((resolveClose) => server.close(resolveClose)); }
async function networkProxy(upstream) {
  const proxy = { offline: false };
  proxy.server = createServer(async (incoming, outgoing) => {
    if (proxy.offline) { outgoing.writeHead(503); outgoing.end(); return; }
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      if (proxy.holdUpload && incoming.method === "PUT" && incoming.url.includes("/objects/")) {
        proxy.uploadBlocked = true;
        // Do not forward this object at all: wait until SIGKILL closes the
        // client response, proving the journal covers an in-flight request.
        await new Promise((resolveClosed) => outgoing.once("close", resolveClosed));
        return;
      }
      const headers = { ...incoming.headers };
      delete headers.host;
      delete headers.connection;
      const body = Buffer.concat(chunks);
      const response = await fetch(`${upstream}${incoming.url}`, { method: incoming.method, headers,
        body: body.length ? body : undefined, signal: AbortSignal.timeout(10_000) });
      // Node fetch transparently decodes compressed responses. Forwarding the
      // original encoding/length would make the CLI decode the plaintext twice.
      const responseHeaders = Object.fromEntries(response.headers);
      delete responseHeaders["content-encoding"];
      delete responseHeaders["content-length"];
      delete responseHeaders["transfer-encoding"];
      outgoing.writeHead(response.status, responseHeaders);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (outgoing.headersSent) outgoing.destroy();
      else { outgoing.writeHead(503); outgoing.end(); }
    }
  });
  await listen(proxy.server);
  proxy.url = `http://127.0.0.1:${proxy.server.address().port}`;
  return proxy;
}
