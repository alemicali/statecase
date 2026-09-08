import assert from "node:assert/strict";
import { contractHeaders } from "./contract.mjs";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Run only inside a disposable sandbox, against an explicitly allowlisted UAT
// account. The orchestrator must remove this account's exact D1/R2 targets and
// the sandbox after collecting this driver's non-secret evidence.
const apiUrl = process.env.STATECASE_UAT_API_URL ?? "https://statecase-api.hi-0e6.workers.dev";
const email = process.env.STATECASE_UAT_EMAIL;
const cli = process.env.STATECASE_UAT_CLI;
const root = process.env.STATECASE_UAT_ROOT;
assert.equal(process.env.STATECASE_UAT_CONFIRM, "create-and-modify-remote-state");
assert.ok(email && cli && root, "explicit disposable email, packaged CLI, and fixture root are required");
assert.ok(isAbsolute(root) && resolve(root) === root && root.split("/").filter(Boolean).length >= 2, "use a dedicated absolute fixture root");

const password = `Uat-${randomBytes(32).toString("base64url")}`;
const recoveryPassphrase = `Recovery-${randomBytes(32).toString("base64url")}`;
const machines = Object.fromEntries(["owner", "offline", "lost", "replacement", "scoped", "new-scoped"].map((name) => [name, join(root, name)]));
const folders = Object.fromEntries(["owner", "offline", "lost", "replacement", "scoped", "new-scoped"].map((name) => [name, join(root, "data", name)]));
const kits = [1, 2, 3].map((epoch) => join(root, "recovery", `epoch-${epoch}.json`));
await Promise.all(Object.values(folders).map((path) => mkdir(path, { recursive: true })));
const signup = await request("/api/auth/sign-up/email", { method: "POST", body: { email, name: "Statecase key rotation UAT", password } });
assert.equal(signup.status, 200, "disposable signup failed");
const cookie = signup.headers.get("set-cookie");
assert.ok(cookie, "disposable signup did not create a browser session");
const tokens = {};
for (const name of ["owner", "offline", "lost", "replacement"]) {
  tokens[name] = await authorizeDevice(cookie);
  run(name, ["login", "--non-interactive", "--device-name", `Rotation UAT ${name}`], { token: tokens[name] });
}
const vault = run("owner", ["vault", "create", "Rotation UAT", "--recovery-file", kits[0]]);
assert.match(vault.id, /^vlt_[a-f0-9]{32}$/u);
// This file contains only fixture IDs, never credentials, and lets an interrupted
// orchestrator resolve exact cleanup targets without scanning unrelated vaults.
await writeFile(join(root, "cleanup-targets.json"), JSON.stringify({ email, vaultId: vault.id }), { mode: 0o600, flag: "wx" });
for (const name of ["offline", "lost"]) run(name, ["vault", "join", vault.id, "--recovery-file", kits[0]]);
await writeFile(join(folders.owner, "context.txt"), "epoch one\n");
const drop = run("owner", ["drop", "add", folders.owner, "--name", "Rotation context"]);
const historical = run("owner", ["push"]).results[0].revisionId;
for (const name of ["offline", "lost"]) {
  run(name, ["drop", "map", drop.id, folders[name], "--name", "Rotation context"]);
  run(name, ["pull"]);
  await assertContent(name, "epoch one\n");
}
const initialBootstrap = join(root, "bootstrap", "epoch-one.token");
run("owner", ["token", "create", "--namespace", `drop:${drop.id}`, "--actions", "read", "--output", initialBootstrap]);
run("scoped", ["bootstrap", "--token-file", initialBootstrap, "--non-interactive"]);
run("scoped", ["drop", "map", drop.id, folders.scoped, "--name", "Scoped context", "--mode", "consume"]);
run("scoped", ["pull"]);
await assertContent("scoped", "epoch one\n");
const lost = await config("lost");
const revoked = run("owner", ["device", "revoke", lost.deviceId, "--yes"]);
assert.equal(revoked.keyRotationRequired, true);
assert.equal(revoked.revoked, true);

const existingKit = await readFile(kits[0]);
assert.notEqual(runRaw("owner", ["vault", "key", "rotate", "--recovery-file", kits[0], "--yes"]).status, 0);
assert.ok((await readFile(kits[0])).equals(existingKit), "existing recovery kit changed");
const beforeOffline = await readFile(join(machines.offline, "credentials.json"));
for (const epoch of [2, 3]) {
  const rotation = run("owner", ["vault", "key", "rotate", "--recovery-file", kits[epoch - 1], "--yes"]);
  assert.equal(rotation.rotated, true);
  assert.equal(rotation.keyEpoch, epoch);
  assert.equal((await stat(kits[epoch - 1])).mode & 0o777, 0o600);
  await writeFile(join(folders.owner, "context.txt"), `epoch ${epoch}\n`);
  run("owner", ["push"]);
  assert.ok((await readFile(join(machines.offline, "credentials.json"))).equals(beforeOffline), "offline machine mutated without a command");
  const revokedAttempt = runRaw("lost", ["pull"]);
  assert.ok([3, 4].includes(revokedAttempt.status), "revoked device did not return an authentication/authorization denial");
  await assertContent("lost", "epoch one\n");
  const scopedAttempt = runRaw("scoped", ["pull"]);
  assert.ok([3, 4].includes(scopedAttempt.status), "pre-rotation scoped session did not return an authentication/authorization denial");
  await assertContent("scoped", "epoch one\n");
  console.log(JSON.stringify({ phase: "rotated", keyEpoch: epoch, revokedDeviceDenied: true, oldScopedSessionDenied: true }));
}
run("offline", ["pull"]);
await assertContent("offline", "epoch 3\n");
const peer = await credentials("offline");
assert.equal(peer.vaultKeyrings[vault.id].currentEpoch, 3);
assert.deepEqual(Object.keys(peer.vaultKeyrings[vault.id].keys), ["1", "2", "3"]);
assert.ok(new Set(Object.values(peer.vaultKeyrings[vault.id].keys)).size === 3, "rotation reused a root key");

const replacementId = (await config("replacement")).deviceId;
const beforeReplacement = await readFile(join(machines.replacement, "credentials.json"));
for (const staleKit of kits.slice(0, 2)) {
  assert.equal(runRaw("replacement", ["vault", "join", vault.id, "--recovery-file", staleKit]).status, 6, "stale recovery kit was not rejected");
  assert.ok((await readFile(join(machines.replacement, "credentials.json"))).equals(beforeReplacement), "stale kit changed local authority");
}
const recipients = await request(`/v1/vaults/${vault.id}/key-recipients`, { headers: { authorization: `Bearer ${tokens.owner}` } });
assert.equal(recipients.status, 200);
assert.ok(!recipients.json.devices.some((device) => device.id === replacementId), "stale recovery added membership");
assert.ok(!recipients.json.devices.some((device) => device.id === lost.deviceId), "revoked device remained an eligible recipient");
run("replacement", ["vault", "join", vault.id, "--recovery-file", kits[2]]);
run("replacement", ["drop", "map", drop.id, folders.replacement, "--name", "Recovered context"]);
run("replacement", ["pull"]);
await assertContent("replacement", "epoch 3\n");
const currentBootstrap = join(root, "bootstrap", "epoch-three.token");
run("owner", ["token", "create", "--namespace", `drop:${drop.id}`, "--actions", "read", "--output", currentBootstrap]);
run("new-scoped", ["bootstrap", "--token-file", currentBootstrap, "--non-interactive"]);
run("new-scoped", ["drop", "map", drop.id, folders["new-scoped"], "--name", "Current scoped context", "--mode", "consume"]);
run("new-scoped", ["pull"]);
await assertContent("new-scoped", "epoch 3\n");

const preview = run("owner", ["restore", "--revision", historical, "--mapping", drop.id, "--in-place", "--dry-run"]);
assert.equal(preview.dryRun, true);
await assertContent("owner", "epoch 3\n");
const restored = run("owner", ["restore", "--revision", historical, "--mapping", drop.id, "--in-place", "--yes"]);
assert.notEqual(restored.result.revisionId, historical, "restore rewound shared history");
for (const name of ["owner", "offline", "replacement", "new-scoped"]) {
  if (name !== "owner") run(name, ["pull"]);
  await assertContent(name, "epoch one\n");
}
console.log(JSON.stringify({ result: "pass", vaultId: vault.id, dropId: drop.id, finalKeyEpoch: 3,
  historicalRevisionId: historical, restoredRevisionId: restored.result.revisionId,
  offlineMultiEpochCatchup: true, staleEnrollmentNonMutating: true,
  currentRecoveryAndBootstrap: true, historicalRestoreAcrossEpochs: true,
  revokedDeviceDenied: true, oldScopedSessionDenied: true,
}, null, 2));

async function assertContent(name, content) { assert.equal(await readFile(join(folders[name], "context.txt"), "utf8"), content); }
async function config(name) { return JSON.parse(await readFile(join(machines[name], "config.json"), "utf8")); }
async function credentials(name) { return JSON.parse(await readFile(join(machines[name], "credentials.json"), "utf8")); }

function runRaw(name, args, options = {}) {
  const env = { ...process.env, HOME: join(machines[name], "user-home"),
    CODEX_HOME: join(machines[name], "codex-home"), CODEX_SQLITE_HOME: join(machines[name], "codex-sqlite"),
    CLAUDE_CONFIG_DIR: join(machines[name], "claude-home"), STATECASE_HOME: machines[name],
    STATECASE_API_URL: apiUrl, STATECASE_RECOVERY_PASSPHRASE: recoveryPassphrase };
  delete env.STATECASE_TOKEN;
  if (options.token) env.STATECASE_TOKEN = options.token;
  const result = spawnSync(cli, ["--json", ...args], { encoding: "utf8", env, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
  assert.ok(!result.error, `CLI ${args[0]} failed to start or timed out`);
  assert.ok(Number.isInteger(result.status), `CLI ${args[0]} terminated without an exit code`);
  return result;
}
function run(name, args, options) {
  const result = runRaw(name, args, options);
  assert.equal(result.status, 0, `CLI ${name}/${args.slice(0, 2).join(" ")} failed; diagnostics withheld to protect credentials`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  assert.ok(line, "CLI returned no JSON");
  return JSON.parse(line);
}
async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  for (const [name, value] of Object.entries(contractHeaders)) headers.set(name, value);
  let body;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("origin", apiUrl);
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${apiUrl}${path}`, { method: options.method, headers, body, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, headers: response.headers, json };
}
async function authorizeDevice(cookie) {
  const issued = await request("/api/auth/device/code", { method: "POST", body: { client_id: "statecase-cli", scope: "sync" } });
  assert.equal(issued.status, 200, "device code issue failed");
  const inspected = await request(`/api/auth/device?user_code=${encodeURIComponent(issued.json.user_code)}`, { headers: { cookie } });
  assert.equal(inspected.status, 200, "device code inspection failed");
  const approved = await request("/api/auth/device/approve", { method: "POST", headers: { cookie }, body: { userCode: issued.json.user_code } });
  assert.equal(approved.status, 200, "device approval failed");
  const exchanged = await request("/api/auth/device/token", { method: "POST", body: {
    client_id: "statecase-cli", device_code: issued.json.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  } });
  assert.equal(exchanged.status, 200, "device token exchange failed");
  assert.equal(typeof exchanged.json.access_token, "string");
  return exchanged.json.access_token;
}
