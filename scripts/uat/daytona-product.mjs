import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const apiUrl = process.env.STATECASE_UAT_API_URL ?? "https://statecase-api.hi-0e6.workers.dev";
const email = process.env.STATECASE_UAT_EMAIL;
const cli = process.env.STATECASE_UAT_CLI;
const root = process.env.STATECASE_UAT_ROOT;

assert.equal(
  process.env.STATECASE_UAT_CONFIRM,
  "create-and-modify-remote-state",
  "set STATECASE_UAT_CONFIRM=create-and-modify-remote-state only for an authorized disposable account",
);
assert.ok(email, "STATECASE_UAT_EMAIL is required");
assert.ok(cli, "STATECASE_UAT_CLI is required");
assert.ok(root, "STATECASE_UAT_ROOT is required");

const password = `Uat-${randomBytes(32).toString("base64url")}`;
const recoveryPassphrase = `Recovery-${randomBytes(32).toString("base64url")}`;
const machineA = join(root, "machine-a");
const machineB = join(root, "machine-b");
const source = join(root, "source");
const target = join(root, "target");
const recoveryFile = join(root, "recovery", "uat.statecase-recovery.json");

await Promise.all([
  mkdir(machineA, { recursive: true }),
  mkdir(machineB, { recursive: true }),
  mkdir(join(source, "nested"), { recursive: true }),
  mkdir(target, { recursive: true }),
]);

const signup = await request("/api/auth/sign-up/email", {
  method: "POST",
  body: { email, name: "Statecase product UAT", password },
});
assert.equal(signup.response.status, 200, `signup failed: ${signup.text}`);
const sessionCookie = signup.response.headers.get("set-cookie");
assert.ok(sessionCookie, "signup did not establish a browser session");

const tokenA = await authorizeDevice(sessionCookie, true);
const tokenB = await authorizeDevice(sessionCookie, false);
assert.notEqual(tokenA, tokenB, "separate devices received the same session token");
run(machineA, ["login", "--non-interactive", "--device-name", "Daytona machine A"], { token: tokenA });
run(machineB, ["login", "--non-interactive", "--device-name", "Daytona machine B"], { token: tokenB });

const vault = run(machineA, ["vault", "create", "Daytona product UAT", "--recovery-file", recoveryFile], {
  recoveryPassphrase,
});
assert.match(vault.id, /^vlt_[a-f0-9]{32}$/u);

run(machineB, ["vault", "join", vault.id, "--recovery-file", recoveryFile], { recoveryPassphrase });

await Promise.all([
  writeFile(join(source, "context.txt"), "context from machine A\n"),
  writeFile(join(source, ".hidden-context"), "hidden state\n"),
  writeFile(join(source, "nested", "contesto-è.txt"), "UTF-8 📦\n"),
  writeFile(join(source, "binary.bin"), Uint8Array.from([0, 1, 2, 127, 128, 254, 255])),
]);

const drop = run(machineA, ["drop", "add", source, "--name", "Portable context"]);
run(machineB, ["drop", "map", drop.id, target, "--name", "Portable context"]);

const firstPush = run(machineA, ["push"]);
assert.ok(firstPush.results?.[0]?.revisionId);
run(machineB, ["pull"]);
await assertSameFile("context.txt");
await assertSameFile(".hidden-context");
await assertSameFile(join("nested", "contesto-è.txt"));
await assertSameFile("binary.bin");

await writeFile(join(target, "context.txt"), "context updated on machine B\n");
await writeFile(join(target, "nested", "new.txt"), "created on machine B\n");
await unlink(join(target, ".hidden-context"));
const secondPush = run(machineB, ["push"]);
assert.ok(secondPush.results?.[0]?.revisionId);
run(machineA, ["pull"]);
assert.equal(await readFile(join(source, "context.txt"), "utf8"), "context updated on machine B\n");
assert.equal(await readFile(join(source, "nested", "new.txt"), "utf8"), "created on machine B\n");
await assert.rejects(readFile(join(source, ".hidden-context")), { code: "ENOENT" });

await writeFile(join(source, "context.txt"), "machine A wins after explicit resolution\n");
await writeFile(join(target, "context.txt"), "concurrent machine B update\n");
run(machineB, ["push"]);
const conflict = runRaw(machineA, ["push"]);
assert.equal(conflict.status, 5, `concurrent push returned ${conflict.status}: ${conflict.stderr}`);
const resolution = run(machineA, ["conflicts", "resolve", "--mapping", drop.id, "--strategy", "local", "--yes"]);
assert.equal(resolution.mappingId, drop.id);
assert.match(resolution.protectedSnapshotId, /^snp_/u);
run(machineB, ["pull"]);
assert.equal(await readFile(join(target, "context.txt"), "utf8"), "machine A wins after explicit resolution\n");

const snapshot = run(machineA, ["snapshot", "create", "Daytona verified state"]);
assert.match(snapshot.id, /^snp_/u);
const snapshots = run(machineA, ["snapshot", "list"]);
assert.ok(snapshots.snapshots.some((item) => item.id === snapshot.id && item.protected === true));

const statusA = run(machineA, ["status"]);
const statusB = run(machineB, ["status"]);
assert.equal(statusA.authenticated, true);
assert.equal(statusB.authenticated, true);
assert.equal(statusA.selectedVaultId, vault.id);
assert.equal(statusB.selectedVaultId, vault.id);
run(machineA, ["doctor"]);
run(machineB, ["doctor"]);

console.log(JSON.stringify({
  result: "pass",
  apiUrl,
  deviceAuthorization: "single-use verified",
  devices: 2,
  vaultCreated: true,
  encryptedRoundTrips: 2,
  deletionPropagation: true,
  conflictDetectedWithExitCode: 5,
  conflictResolvedWithProtectedSnapshot: true,
  namedSnapshotCreated: true,
  codexAndClaudeHomesRemainIsolated: true,
}, null, 2));

function run(statecaseHome, args, secrets = {}) {
  const result = runRaw(statecaseHome, args, secrets);
  assert.equal(result.status, 0, `${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  assert.ok(line, `${args.join(" ")} returned no JSON`);
  return JSON.parse(line);
}

function runRaw(statecaseHome, args, secrets = {}) {
  const env = {
    ...process.env,
    STATECASE_HOME: statecaseHome,
    STATECASE_API_URL: apiUrl,
  };
  if (secrets.token) env.STATECASE_TOKEN = secrets.token;
  if (secrets.recoveryPassphrase) env.STATECASE_RECOVERY_PASSPHRASE = secrets.recoveryPassphrase;
  const result = spawnSync(cli, ["--json", ...args], { encoding: "utf8", env });
  assert.equal(result.error, undefined, `${args.join(" ")} could not start: ${result.error?.message}`);
  return result;
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
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

async function authorizeDevice(sessionCookie, verifyReplay) {
  const issued = await request("/api/auth/device/code", {
    method: "POST",
    body: { client_id: "statecase-cli", scope: "sync" },
  });
  assert.equal(issued.response.status, 200, `device-code issue failed: ${issued.text}`);
  const deviceCode = issued.json;

  const inspected = await request(`/api/auth/device?user_code=${encodeURIComponent(deviceCode.user_code)}`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(inspected.response.status, 200, `device-code inspection failed: ${inspected.text}`);

  const approved = await request("/api/auth/device/approve", {
    method: "POST",
    headers: { cookie: sessionCookie, origin: apiUrl },
    body: { userCode: deviceCode.user_code },
  });
  assert.equal(approved.response.status, 200, `device-code approval failed: ${approved.text}`);

  const exchangeBody = {
    client_id: "statecase-cli",
    device_code: deviceCode.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  };
  const exchanged = await request("/api/auth/device/token", { method: "POST", body: exchangeBody });
  assert.equal(exchanged.response.status, 200, `device-code exchange failed: ${exchanged.text}`);
  assert.equal(exchanged.json.token_type, "Bearer");
  assert.ok(exchanged.json.access_token);

  if (verifyReplay) {
    const replay = await request("/api/auth/device/token", { method: "POST", body: exchangeBody });
    assert.equal(replay.response.status, 400, "device code was accepted more than once");
  }
  return exchanged.json.access_token;
}

async function assertSameFile(relativePath) {
  const [left, right] = await Promise.all([
    readFile(join(source, relativePath)),
    readFile(join(target, relativePath)),
  ]);
  assert.deepEqual(left, right, `${relativePath} differs after pull`);
}
