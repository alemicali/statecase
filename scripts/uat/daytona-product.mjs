import assert from "node:assert/strict";
import { contractHeaders } from "./contract.mjs";
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
const machineC = join(root, "machine-c");
const machineD = join(root, "machine-d");
const source = join(root, "source");
const target = join(root, "target");
const gitSource = join(root, "git-source");
const gitRemote = join(root, "git-remote.git");
const gitTarget = join(root, "git-target");
const lfsSource = join(root, "lfs-source");
const lfsRemote = join(root, "lfs-remote.git");
const lfsTarget = join(root, "lfs-target");
const codexHomeA = join(machineA, "codex-home");
const codexHomeD = join(machineD, "codex-home");
const sessionWorkspaceA = join(root, "session-workspace-a");
const sessionWorkspaceD = join(root, "session-workspace-d");
const recoveryFile = join(root, "recovery", "uat.statecase-recovery.json");

await Promise.all([
  mkdir(machineA, { recursive: true }),
  mkdir(machineB, { recursive: true }),
  mkdir(machineC, { recursive: true }),
  mkdir(machineD, { recursive: true }),
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
const tokenC = await authorizeDevice(sessionCookie, false);
const tokenD = await authorizeDevice(sessionCookie, false);
assert.notEqual(tokenA, tokenB, "separate devices received the same session token");
assert.notEqual(tokenB, tokenC, "separate devices received the same session token");
assert.notEqual(tokenA, tokenC, "separate devices received the same session token");
assert.equal(new Set([tokenA, tokenB, tokenC, tokenD]).size, 4, "separate devices did not receive unique session tokens");
run(machineA, ["login", "--non-interactive", "--device-name", "Daytona machine A"], { token: tokenA });
run(machineB, ["login", "--non-interactive", "--device-name", "Daytona machine B"], { token: tokenB });
run(machineC, ["login", "--non-interactive", "--device-name", "Daytona machine C"], { token: tokenC });
run(machineD, ["login", "--non-interactive", "--device-name", "Daytona machine D"], { token: tokenD });

const vault = run(machineA, ["vault", "create", "Daytona product UAT", "--recovery-file", recoveryFile], {
  recoveryPassphrase,
});
assert.match(vault.id, /^vlt_[a-f0-9]{32}$/u);

run(machineB, ["vault", "join", vault.id, "--recovery-file", recoveryFile], { recoveryPassphrase });
run(machineC, ["vault", "join", vault.id, "--recovery-file", recoveryFile], { recoveryPassphrase });
run(machineD, ["vault", "join", vault.id, "--recovery-file", recoveryFile], { recoveryPassphrase });

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

await mkdir(gitSource, { recursive: true });
await writeFile(join(gitSource, "tracked.txt"), "Git baseline A\n");
git(["init", "-q", gitSource]);
git(["-C", gitSource, "add", "tracked.txt"]);
git(["-C", gitSource, "-c", "user.name=Statecase UAT", "-c", "user.email=uat@statecase.invalid", "commit", "-qm", "baseline A"]);
git(["init", "--bare", "-q", gitRemote]);
git(["-C", gitSource, "branch", "-M", "main"]);
git(["-C", gitSource, "remote", "add", "origin", `file://${gitRemote}`]);
git(["-C", gitSource, "push", "-q", "-u", "origin", "main"]);
const gitBaseline = git(["-C", gitSource, "rev-parse", "HEAD"]).stdout.trim();
await writeFile(join(gitSource, "tracked.txt"), "portable Git overlay\n");
await writeFile(join(gitSource, "untracked.txt"), "portable untracked file\n");
run(machineA, ["workspace", "attach", "--id", "ws_daytona", "--path", gitSource, "--mode", "git-overlay", "--git-fetch", "never"]);
run(machineA, ["push"]);

git(["-C", gitSource, "reset", "--hard", "-q", "HEAD"]);
await writeFile(join(gitSource, "tracked.txt"), "Git baseline B\n");
git(["-C", gitSource, "add", "tracked.txt"]);
git(["-C", gitSource, "-c", "user.name=Statecase UAT", "-c", "user.email=uat@statecase.invalid", "commit", "-qm", "baseline B"]);
git(["-C", gitSource, "push", "-q", "origin", "main"]);
git(["clone", "-q", "--depth", "1", "--branch", "main", `file://${gitRemote}`, gitTarget]);
const targetHead = git(["-C", gitTarget, "rev-parse", "HEAD"]).stdout.trim();
assert.notEqual(targetHead, gitBaseline);
assert.notEqual(git(["-C", gitTarget, "cat-file", "-e", `${gitBaseline}^{commit}`], false).status, 0);

run(machineB, ["workspace", "attach", "--id", "ws_daytona", "--path", gitTarget, "--mode", "git-overlay", "--git-fetch", "ask"]);
const approvalRequired = runRaw(machineB, ["pull"]);
assert.equal(approvalRequired.status, 5, `ask policy returned ${approvalRequired.status}: ${approvalRequired.stderr}`);
assert.match(approvalRequired.stderr, /BASELINE_UNAVAILABLE/u);
assert.equal(git(["-C", gitTarget, "rev-parse", "HEAD"]).stdout.trim(), targetHead);
assert.notEqual(git(["-C", gitTarget, "cat-file", "-e", `${gitBaseline}^{commit}`], false).status, 0);

run(machineB, ["workspace", "attach", "--id", "ws_daytona", "--path", gitTarget, "--mode", "git-overlay", "--git-fetch", "auto"]);
run(machineB, ["pull"]);
assert.equal(git(["-C", gitTarget, "rev-parse", "HEAD"]).stdout.trim(), gitBaseline);
assert.equal(await readFile(join(gitTarget, "tracked.txt"), "utf8"), "portable Git overlay\n");
assert.equal(await readFile(join(gitTarget, "untracked.txt"), "utf8"), "portable untracked file\n");

await mkdir(lfsSource, { recursive: true });
git(["init", "-q", lfsSource]);
git(["-C", lfsSource, "lfs", "install", "--local"]);
git(["-C", lfsSource, "lfs", "track", "*.bin"]);
const lfsBytes = randomBytes(96 * 1024);
await writeFile(join(lfsSource, "portable.bin"), lfsBytes);
git(["-C", lfsSource, "add", ".gitattributes", "portable.bin"]);
git(["-C", lfsSource, "-c", "user.name=Statecase UAT", "-c", "user.email=uat@statecase.invalid", "commit", "-qm", "LFS baseline"]);
git(["init", "--bare", "-q", lfsRemote]);
git(["-C", lfsSource, "branch", "-M", "main"]);
git(["-C", lfsSource, "remote", "add", "origin", `file://${lfsRemote}`]);
git(["-C", lfsSource, "push", "-q", "-u", "origin", "main"]);
git(["-C", lfsRemote, "symbolic-ref", "HEAD", "refs/heads/main"]);
run(machineA, ["workspace", "attach", "--id", "ws_lfs", "--path", lfsSource, "--mode", "git-overlay", "--git-fetch", "auto"]);
run(machineA, ["push"]);

gitWithEnvironment(["clone", "-q", `file://${lfsRemote}`, lfsTarget], { GIT_LFS_SKIP_SMUDGE: "1" });
git(["-C", lfsTarget, "lfs", "install", "--local", "--skip-smudge"]);
const lfsPointerBytes = await readFile(join(lfsTarget, "portable.bin"));
assert.match(lfsPointerBytes.toString("utf8"), /^version https:\/\/git-lfs\.github\.com\/spec\/v1$/mu);
run(machineC, ["workspace", "attach", "--id", "ws_lfs", "--path", lfsTarget, "--mode", "git-overlay", "--git-fetch", "ask"]);
const lfsApprovalRequired = runRaw(machineC, ["pull"]);
assert.equal(lfsApprovalRequired.status, 5, `LFS ask policy returned ${lfsApprovalRequired.status}: ${lfsApprovalRequired.stderr}`);
assert.match(lfsApprovalRequired.stderr, /GIT_LFS_CONTENT_UNAVAILABLE/u);
assert.deepEqual(await readFile(join(lfsTarget, "portable.bin")), lfsPointerBytes, "ask policy changed the LFS pointer");
run(machineC, ["workspace", "attach", "--id", "ws_lfs", "--path", lfsTarget, "--mode", "git-overlay", "--git-fetch", "auto"]);
run(machineC, ["pull"]);
assert.deepEqual(await readFile(join(lfsTarget, "portable.bin")), lfsBytes, "auto policy did not materialize exact LFS bytes");

await Promise.all([
  mkdir(join(codexHomeA, "sessions", "2026", "09", "07"), { recursive: true }),
  mkdir(codexHomeD, { recursive: true }),
  mkdir(sessionWorkspaceA, { recursive: true }),
  mkdir(sessionWorkspaceD, { recursive: true }),
]);
run(machineA, ["setup", "--harness", "codex"]);
run(machineD, ["setup", "--harness", "codex"]);
run(machineA, ["workspace", "attach", "--id", "ws_session_uat", "--path", sessionWorkspaceA, "--mode", "metadata-only"]);
run(machineD, ["workspace", "attach", "--id", "ws_session_uat", "--path", sessionWorkspaceD, "--mode", "metadata-only"]);
const sourceSession = join(codexHomeA, "sessions", "2026", "09", "07", "uat-session.jsonl");
const baseA = { type: "session_meta", payload: { cwd: sessionWorkspaceA } };
const baseD = { type: "session_meta", payload: { cwd: sessionWorkspaceD } };
const remoteAppend = [
  { type: "tool_call", id: "remote-1", name: "read_file", arguments: { path: join(sessionWorkspaceA, "remote-only.md") } },
  { type: "assistant", id: "remote-2", message: "remote branch" },
];
const localAppend = [
  { type: "tool_call", id: "local-1", name: "read_file", arguments: { path: join(sessionWorkspaceD, "local-only.md") } },
  { type: "assistant", id: "local-2", message: "local branch" },
];
await writeJsonl(sourceSession, [baseA]);
run(machineA, ["push"]);
run(machineD, ["pull"]);
const targetSession = join(codexHomeD, "sessions", "statecase", "ws_session_uat", "uat-session.jsonl");

await writeJsonl(sourceSession, [baseA, ...remoteAppend]);
run(machineA, ["push"]);
await writeJsonl(targetSession, [{ ...baseD, rewritten: true }, ...localAppend]);
const rewritten = runRaw(machineD, ["push"]);
assert.equal(rewritten.status, 5, `rewritten session push returned ${rewritten.status}: ${rewritten.stderr}`);
assert.equal(run(machineA, ["pull"]).results?.[0]?.outcome, "unchanged", "rejected rewrite advanced the remote head");

await writeJsonl(targetSession, [baseD, ...localAppend]);
run(machineD, ["push"]);
const dependencies = run(machineD, ["workspace", "dependencies", "--workspace", "ws_session_uat"]);
const sessionReport = dependencies.reports.find((report) => report.sessionKey.endsWith(":uat-session"));
assert.ok(sessionReport, "merged session capsule was not published");
assert.deepEqual(
  new Set(sessionReport.dependencies.map((dependency) => dependency.logicalPath)),
  new Set(["local-only.md", "remote-only.md"]),
  "merged session capsule did not retain activity from both branches",
);

run(machineD, ["pull"]);
run(machineA, ["pull"]);
await assert.rejects(
  readFile(join(codexHomeA, "sessions", "statecase", "ws_session_uat", "uat-session.jsonl")),
  (error) => error?.code === "ENOENT",
  "origin pull created a divergent canonical session copy",
);
for (const path of [sourceSession, targetSession]) {
  const records = (await readFile(path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  const ids = records.flatMap((record) => typeof record.id === "string" ? [record.id] : []);
  assert.equal(ids.length, 4, `${path} did not contain each append record exactly once`);
  assert.deepEqual(new Set(ids), new Set(["remote-1", "remote-2", "local-1", "local-2"]));
  assert.ok(ids.indexOf("remote-1") < ids.indexOf("remote-2"), `${path} changed remote branch order`);
  assert.ok(ids.indexOf("local-1") < ids.indexOf("local-2"), `${path} changed local branch order`);
}

console.log(JSON.stringify({
  result: "pass",
  apiUrl,
  deviceAuthorization: "single-use verified",
  devices: 4,
  vaultCreated: true,
  encryptedRoundTrips: 2,
  deletionPropagation: true,
  conflictDetectedWithExitCode: 5,
  conflictResolvedWithProtectedSnapshot: true,
  namedSnapshotCreated: true,
  shallowGitBaselineAcquisition: "ask-preserved-auto-restored",
  gitLfsAcquisition: "ask-preserved-auto-verified",
  sameSessionAppendMerge: "rewrite-preserved-branches-converged-dependencies-retained",
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
    HOME: join(statecaseHome, "user-home"),
    CODEX_HOME: join(statecaseHome, "codex-home"),
    CODEX_SQLITE_HOME: join(statecaseHome, "codex-sqlite"),
    CLAUDE_CONFIG_DIR: join(statecaseHome, "claude-home"),
    STATECASE_HOME: statecaseHome,
    STATECASE_API_URL: apiUrl,
  };
  if (secrets.token) env.STATECASE_TOKEN = secrets.token;
  if (secrets.recoveryPassphrase) env.STATECASE_RECOVERY_PASSPHRASE = secrets.recoveryPassphrase;
  const result = spawnSync(cli, ["--json", ...args], { encoding: "utf8", env });
  assert.equal(result.error, undefined, `${args.join(" ")} could not start: ${result.error?.message}`);
  return result;
}

function git(args, expectSuccess = true) {
  return gitWithEnvironment(args, {}, expectSuccess);
}

function gitWithEnvironment(args, environment, expectSuccess = true) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
  });
  assert.equal(result.error, undefined, `git ${args.join(" ")} could not start: ${result.error?.message}`);
  if (expectSuccess) assert.equal(result.status, 0, `git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  return result;
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  for (const [name, value] of Object.entries(contractHeaders)) headers.set(name, value);
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

async function writeJsonl(path, values) {
  await writeFile(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}
