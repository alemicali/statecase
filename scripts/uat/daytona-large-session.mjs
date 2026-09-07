import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

const GIB = 1024 * 1024 * 1024;
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
const workspaceA = join(root, "workspace-a");
const workspaceB = join(root, "workspace-b");
const codexHomeA = join(machineA, "codex-home");
const codexHomeB = join(machineB, "codex-home");
const sourceSession = join(codexHomeA, "sessions", "2026", "09", "07", "large-session.jsonl");
const targetSession = join(codexHomeB, "sessions", "statecase", "ws_large", "large-session.jsonl");
const recoveryFile = join(root, "recovery", "large.statecase-recovery.json");

await Promise.all([
  mkdir(join(codexHomeA, "sessions", "2026", "09", "07"), { recursive: true }),
  mkdir(codexHomeB, { recursive: true }),
  mkdir(workspaceA, { recursive: true }),
  mkdir(workspaceB, { recursive: true }),
]);

const signup = await request("/api/auth/sign-up/email", {
  method: "POST",
  body: { email, name: "Statecase 2 GiB UAT", password },
});
assert.equal(signup.response.status, 200, `signup failed: ${signup.text}`);
const sessionCookie = signup.response.headers.get("set-cookie");
assert.ok(sessionCookie, "signup did not establish a browser session");

const tokenA = await authorizeDevice(sessionCookie);
const tokenB = await authorizeDevice(sessionCookie);
assert.notEqual(tokenA, tokenB, "separate devices received the same session token");
run(machineA, ["login", "--non-interactive", "--device-name", "Daytona large A"], { token: tokenA });
run(machineB, ["login", "--non-interactive", "--device-name", "Daytona large B"], { token: tokenB });
const vault = run(machineA, ["vault", "create", "Daytona 2 GiB UAT", "--recovery-file", recoveryFile], {
  recoveryPassphrase,
});
run(machineB, ["vault", "join", vault.id, "--recovery-file", recoveryFile], { recoveryPassphrase });

for (const [machine, workspace] of [[machineA, workspaceA], [machineB, workspaceB]]) {
  run(machine, ["setup", "--harness", "codex"]);
  run(machine, ["workspace", "attach", "--id", "ws_large", "--path", workspace, "--mode", "metadata-only"]);
}

const metadataA = { type: "session_meta", payload: { cwd: workspaceA } };
const fillerRecords = 32_768;
await generateSession(sourceSession, metadataA, 64 * 1024, fillerRecords);
const generated = await stat(sourceSession);
assert.ok(generated.size >= 2 * GIB, `generated session is only ${generated.size} bytes`);

const initialPush = timedRun(machineA, ["push"]);
const initial = initialPush.output.results[0];
assert.equal(initial.outcome, "pushed");
assert.ok(initial.objects >= 500 && initial.objects <= 600, `unexpected initial object count: ${initial.objects}`);

const initialPull = timedRun(machineB, ["pull"]);
assert.equal(initialPull.output.results[0].outcome, "pulled");
await verifySession(targetSession, workspaceB, fillerRecords, []);

const remoteAppend = { type: "assistant", id: "remote-large", message: "remote branch" };
const localAppend = { type: "assistant", id: "local-large", message: "local branch" };
await appendFile(sourceSession, `${JSON.stringify(remoteAppend)}\n`);
await appendFile(targetSession, `${JSON.stringify(localAppend)}\n`);

const remotePush = timedRun(machineA, ["push"]);
assert.equal(remotePush.output.results[0].outcome, "pushed");
assert.ok(remotePush.output.results[0].objects <= 3, "single append uploaded more than one tail object plus manifest");
assert.ok(remotePush.output.results[0].bytes < 8 * 1024 * 1024, "single append transferred an unbounded payload");

const mergedPush = timedRun(machineB, ["push"]);
assert.equal(mergedPush.output.results[0].outcome, "pushed");
assert.ok(mergedPush.output.results[0].objects <= 3, "merged append uploaded more than bounded tail objects plus manifest");
assert.ok(mergedPush.output.results[0].bytes < 8 * 1024 * 1024, "merged append transferred an unbounded upload payload");

const pullB = timedRun(machineB, ["pull"]);
const pullA = timedRun(machineA, ["pull"]);
assert.equal(pullB.output.results[0].outcome, "pulled");
assert.equal(pullA.output.results[0].outcome, "pulled");
await verifySession(targetSession, workspaceB, fillerRecords, ["remote-large", "local-large"]);
await verifySession(sourceSession, workspaceA, fillerRecords, ["remote-large", "local-large"]);

console.log(JSON.stringify({
  result: "pass",
  vaultId: vault.id,
  sessionBytes: generated.size,
  fillerRecords,
  initialObjects: initial.objects,
  appendObjects: remotePush.output.results[0].objects,
  mergedAppendObjects: mergedPush.output.results[0].objects,
  durationsMs: {
    initialPush: initialPush.durationMs,
    initialPull: initialPull.durationMs,
    remotePush: remotePush.durationMs,
    mergedPush: mergedPush.durationMs,
    pullB: pullB.durationMs,
    pullA: pullA.durationMs,
  },
  boundedTailTransfer: true,
  concurrentMergeOverTwoGiB: true,
  bothNativePathsConverged: true,
}, null, 2));

function run(statecaseHome, args, secrets = {}) {
  return timedRun(statecaseHome, args, secrets).output;
}

function timedRun(statecaseHome, args, secrets = {}) {
  const started = Date.now();
  const env = {
    ...process.env,
    HOME: join(statecaseHome, "user-home"),
    CODEX_HOME: join(statecaseHome, "codex-home"),
    CODEX_SQLITE_HOME: join(statecaseHome, "codex-sqlite"),
    CLAUDE_CONFIG_DIR: join(statecaseHome, "claude-home"),
    STATECASE_HOME: statecaseHome,
    STATECASE_API_URL: apiUrl,
  };
  if (secrets.token) env.STATECASE_TOKEN = secrets.token;
  if (secrets.recoveryPassphrase) env.STATECASE_RECOVERY_PASSPHRASE = secrets.recoveryPassphrase;
  const result = spawnSync(cli, ["--json", ...args], { encoding: "utf8", env, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.error, undefined, `${args.join(" ")} could not start: ${result.error?.message}`);
  assert.equal(result.status, 0, `${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  assert.ok(line, `${args.join(" ")} returned no JSON`);
  return { output: JSON.parse(line), durationMs: Date.now() - started };
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
  assert.equal(approved.response.status, 200, `device-code approval failed: ${approved.text}`);
  const exchanged = await request("/api/auth/device/token", {
    method: "POST",
    body: {
      client_id: "statecase-cli",
      device_code: issued.json.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
  });
  assert.equal(exchanged.response.status, 200, `device-code exchange failed: ${exchanged.text}`);
  assert.ok(exchanged.json.access_token);
  return exchanged.json.access_token;
}

function exactRecord(bytes, index) {
  const prefix = `{"type":"event","index":${index},"payload":"`;
  const suffix = '"}\n';
  const payloadBytes = bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.ok(payloadBytes > 0);
  const record = `${prefix}${"x".repeat(payloadBytes)}${suffix}`;
  assert.equal(Buffer.byteLength(record), bytes);
  return record;
}

async function generateSession(path, metadata, recordBytes, count) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`);
    for (let index = 0; index < count; index += 1) await handle.writeFile(exactRecord(recordBytes, index));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifySession(path, expectedWorkspace, expectedFillerRecords, expectedAppendIds) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  let fillerCount = 0;
  const appendIds = [];
  for await (const line of lines) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (lineNumber === 0) assert.equal(record.payload?.cwd, expectedWorkspace, "workspace path was not localized");
    else if (record.type === "event") {
      assert.equal(Buffer.byteLength(`${line}\n`), 64 * 1024, "filler record changed size");
      fillerCount += 1;
    } else if (typeof record.id === "string") appendIds.push(record.id);
    lineNumber += 1;
  }
  assert.equal(fillerCount, expectedFillerRecords, "large session lost or duplicated filler records");
  assert.deepEqual(new Set(appendIds), new Set(expectedAppendIds), "large session append IDs did not converge");
  assert.equal(appendIds.length, expectedAppendIds.length, "large session duplicated an append record");
}
