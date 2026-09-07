import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const apiUrl = process.env.STATECASE_UAT_API_URL ?? "https://statecase-api.hi-0e6.workers.dev";
const email = process.env.STATECASE_UAT_EMAIL;
const cli = process.env.STATECASE_UAT_CLI;
const root = process.env.STATECASE_UAT_ROOT;

assert.equal(process.env.STATECASE_UAT_CONFIRM, "create-and-modify-remote-state");
assert.ok(email, "STATECASE_UAT_EMAIL is required");
assert.ok(cli, "STATECASE_UAT_CLI is required");
assert.ok(root, "STATECASE_UAT_ROOT is required");

const password = `Uat-${randomBytes(32).toString("base64url")}`;
const recoveryPassphrase = `Recovery-${randomBytes(32).toString("base64url")}`;
const machineA = join(root, "machine-a");
const machineB = join(root, "machine-b");
const source = join(root, "source");
const observer = join(root, "observer");
const recoveryFile = join(root, "recovery", "restore.statecase-recovery.json");
await Promise.all([
  mkdir(machineA, { recursive: true }),
  mkdir(machineB, { recursive: true }),
  mkdir(join(source, "nested"), { recursive: true }),
  mkdir(observer, { recursive: true }),
]);

const signup = await request("/api/auth/sign-up/email", {
  method: "POST",
  body: { email, name: "Statecase restore UAT", password },
});
assert.equal(signup.response.status, 200, `signup failed: ${signup.text}`);
const sessionCookie = signup.response.headers.get("set-cookie");
assert.ok(sessionCookie, "signup did not establish a browser session");
const [tokenA, tokenB] = await Promise.all([authorizeDevice(sessionCookie), authorizeDevice(sessionCookie)]);
run(machineA, ["login", "--non-interactive", "--device-name", "Daytona restore A"], { token: tokenA });
run(machineB, ["login", "--non-interactive", "--device-name", "Daytona restore B"], { token: tokenB });
const vault = run(machineA, ["vault", "create", "Daytona restore UAT", "--recovery-file", recoveryFile], { recoveryPassphrase });
run(machineB, ["vault", "join", vault.id, "--recovery-file", recoveryFile], { recoveryPassphrase });

await Promise.all([
  writeFile(join(source, "context.txt"), "historical context\n"),
  writeFile(join(source, "resurrect.txt"), "historical resurrection\n"),
  writeFile(join(source, "nested", "exact.txt"), "nested historical\n"),
]);
const drop = run(machineA, ["drop", "add", source, "--name", "Restore fixture"]);
run(machineB, ["drop", "map", drop.id, observer, "--name", "Restore fixture"]);
const historical = run(machineA, ["push"]);
const historicalRevisionId = historical.results[0].revisionId;

await writeFile(join(source, "context.txt"), "current context\n");
await rm(join(source, "resurrect.txt"));
await rm(join(source, "nested"), { recursive: true });
await writeFile(join(source, "newer.txt"), "newer remote state\n");
const current = run(machineA, ["push"]);
await writeFile(join(source, "local-only.txt"), "unpublished local state\n");

const preview = run(machineA, ["restore", "--revision", historicalRevisionId, "--mapping", drop.id, "--in-place", "--dry-run"]);
assert.equal(preview.mode, "in-place");
assert.equal(preview.dryRun, true);
assert.equal(await readFile(join(source, "context.txt"), "utf8"), "current context\n");
assert.equal(await readFile(join(source, "local-only.txt"), "utf8"), "unpublished local state\n");

const restored = run(machineA, ["restore", "--revision", historicalRevisionId, "--mapping", drop.id, "--in-place", "--yes"]);
assert.match(restored.protectedSnapshotId, /^snp_/u);
assert.match(restored.emergencySnapshotPath, /\/recovery\/restore_/u);
assert.notEqual(restored.result.revisionId, historicalRevisionId);
assert.notEqual(restored.result.revisionId, current.results[0].revisionId);
await assertHistorical(source);

run(machineB, ["pull"]);
await assertHistorical(observer);

const rollback = run(machineA, ["emergency", "rollback", restored.emergencySnapshotPath, "--yes"], { apiUrl: "http://127.0.0.1:1" });
assert.equal(rollback.restored, true);
assert.equal(await readFile(join(source, "context.txt"), "utf8"), "current context\n");
assert.equal(await readFile(join(source, "newer.txt"), "utf8"), "newer remote state\n");
assert.equal(await readFile(join(source, "local-only.txt"), "utf8"), "unpublished local state\n");
await assert.rejects(readFile(join(source, "resurrect.txt")), { code: "ENOENT" });

console.log(JSON.stringify({
  result: "pass",
  vaultId: vault.id,
  dropId: drop.id,
  historicalRevisionId,
  currentRevisionId: current.results[0].revisionId,
  restoredRevisionId: restored.result.revisionId,
  protectedSnapshotCreated: true,
  emergencyRollbackOffline: true,
  observerConverged: true,
}, null, 2));

async function assertHistorical(directory) {
  assert.equal(await readFile(join(directory, "context.txt"), "utf8"), "historical context\n");
  assert.equal(await readFile(join(directory, "resurrect.txt"), "utf8"), "historical resurrection\n");
  assert.equal(await readFile(join(directory, "nested", "exact.txt"), "utf8"), "nested historical\n");
  await assert.rejects(readFile(join(directory, "newer.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(directory, "local-only.txt")), { code: "ENOENT" });
}

function run(statecaseHome, args, secrets = {}) {
  const result = spawnSync(cli, ["--json", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(statecaseHome, "user-home"),
      CODEX_HOME: join(statecaseHome, "codex-home"),
      CODEX_SQLITE_HOME: join(statecaseHome, "codex-sqlite"),
      CLAUDE_CONFIG_DIR: join(statecaseHome, "claude-home"),
      STATECASE_HOME: statecaseHome,
      STATECASE_API_URL: secrets.apiUrl ?? apiUrl,
      ...(secrets.token ? { STATECASE_TOKEN: secrets.token } : {}),
      ...(secrets.recoveryPassphrase ? { STATECASE_RECOVERY_PASSPHRASE: secrets.recoveryPassphrase } : {}),
    },
  });
  assert.equal(result.error, undefined, `${args.join(" ")} could not start`);
  assert.equal(result.status, 0, `${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  assert.ok(line, `${args.join(" ")} returned no JSON`);
  return JSON.parse(line);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  let body;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    if (!headers.has("origin")) headers.set("origin", apiUrl);
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${apiUrl}${path}`, { method: options.method, headers, body });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { response, text, json };
}

async function authorizeDevice(sessionCookie) {
  const issued = await request("/api/auth/device/code", {
    method: "POST",
    body: { client_id: "statecase-cli", scope: "sync" },
  });
  assert.equal(issued.response.status, 200, `device-code issue failed: ${issued.text}`);
  const inspected = await request(`/api/auth/device?user_code=${encodeURIComponent(issued.json.user_code)}`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(inspected.response.status, 200, `device-code inspection failed: ${inspected.text}`);
  const approved = await request("/api/auth/device/approve", {
    method: "POST",
    headers: { cookie: sessionCookie, origin: apiUrl },
    body: { userCode: issued.json.user_code },
  });
  assert.equal(approved.response.status, 200, `device approval failed: ${approved.text}`);
  const exchanged = await request("/api/auth/device/token", {
    method: "POST",
    body: {
      client_id: "statecase-cli",
      device_code: issued.json.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
  });
  assert.equal(exchanged.response.status, 200, `device exchange failed: ${exchanged.text}`);
  return exchanged.json.access_token;
}
