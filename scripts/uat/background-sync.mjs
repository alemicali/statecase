import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";

// Fully local workerd/D1/R2 + real CLI daemon processes. No Cloudflare account
// or existing harness/profile is consulted. All credentials are disposable.
const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = await mkdtemp(join(tmpdir(), "stc-background-"));
const cli = join(repository, "apps/cli/dist/bin.js");
const wrangler = join(repository, "node_modules/wrangler/bin/wrangler.js");
const children = [];
const proxies = [];
const env = { PATH: process.env.PATH, HOME: join(root, "user-home"), TMPDIR: join(root, "tmp"), WRANGLER_SEND_METRICS: "false",
  CODEX_HOME: join(root, "codex"), CODEX_SQLITE_HOME: join(root, "codex-sqlite"), CLAUDE_CONFIG_DIR: join(root, "claude") };
const email = "background@example.invalid";
const passphrase = randomBytes(32).toString("base64url");
const password = randomBytes(32).toString("base64url");
let apiUrl;
let vault;
const machines = {};
try {
  await mkdir(env.HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.TMPDIR, { mode: 0o700 });
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
  await command("b", ["vault", "join", vault.id, "--recovery-file", kit]);
  await writeFile(join(machines.a.drop, "context.txt"), "initial\n");
  const drop = await command("a", ["drop", "add", machines.a.drop, "--name", "Background context"]);
  await command("a", ["push"]);
  await command("b", ["drop", "map", drop.id, machines.b.drop]);
  await command("b", ["pull"]);
  for (const name of ["a", "b"]) {
    machines[name].daemon = child(cli, ["daemon", "foreground"], machines[name].env);
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
  await stop(machines.a.daemon, "SIGKILL");
  machines.a.proxy.holdUpload = false;
  await writeFile(join(machines.a.drop, "offline.txt"), "offline a\n");
  machines.a.daemon = child(cli, ["daemon", "foreground"], machines.a.env);
  await eventually(async () => (await status("a")).queued === true, "visible offline journal");
  for (const operation of interrupted) assert.ok(journal("a").some((row) => row.id === operation.id), "restart discarded the interrupted operation");
  phase("interrupted-upload-journal-retained");
  await writeFile(join(machines.b.drop, "online.txt"), "online b\n");
  await eventually(async () => await head() !== beforeUpload, "online peer publishes while a remains offline");
  await stop(machines.a.daemon, "SIGKILL");
  machines.a.daemon = child(cli, ["daemon", "foreground"], machines.a.env);
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
  // Cover at least one maximum reconciliation and two remote polls.
  await new Promise((resolveWait) => setTimeout(resolveWait, 45_000));
  assert.equal(await head(), before, "idle daemons produced spurious revisions");
  phase("deletion-and-idle-noop");
  for (const name of ["a", "b"]) assertLive(machines[name].daemon);
} finally {
  await Promise.all(children.map((entry) => stop(entry)));
  await Promise.all(proxies.map((proxy) => close(proxy.server)));
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ result: "pass", runtime: "two-authenticated-cli-daemons", backend: "local-workerd-d1-r2",
  automaticBidirectionalTransfer: true, interruptedUploadJournalReplay: true, offlineCrashRecovery: true, disjointConvergence: true,
  deletionPropagation: true, idleNoop: true, cleanupVerified: true,
  boundary: "no native service manager, real harness, or live Cloudflare deployment qualified by this driver" }));

function phase(name) { console.log(JSON.stringify({ phase: name, result: "pass" })); }
function child(entrypoint, args, childEnv) {
  const processHandle = spawn(process.execPath, [entrypoint, ...args], { env: childEnv, cwd: repository, stdio: "ignore", detached: true });
  const tracked = { process: processHandle, done: false, expectedStop: false };
  tracked.exited = new Promise((resolveExit) => {
    processHandle.once("exit", () => { tracked.done = true; resolveExit(); });
    processHandle.once("error", () => { tracked.done = true; resolveExit(); });
  });
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
async function status(name) { assertLive(machines[name].daemon); return command(name, ["daemon", "status"]); }
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
    headers: { ...(options.body ? { "content-type": "application/json", origin: apiUrl } : {}), ...options.headers },
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
