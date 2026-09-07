import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
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
const source = join(root, "workspace-source");
const observer = join(root, "workspace-observer");
const remote = join(root, "workspace-origin.git");
const recoveryFile = join(root, "recovery", "workspace.statecase-recovery.json");

await Promise.all([
  mkdir(machineA, { recursive: true }),
  mkdir(machineB, { recursive: true }),
  mkdir(source, { recursive: true }),
]);

const signup = await request("/api/auth/sign-up/email", {
  method: "POST",
  body: { email, name: "Statecase workspace restore UAT", password },
});
assert.equal(signup.response.status, 200, `signup failed: ${signup.text}`);
const sessionCookie = signup.response.headers.get("set-cookie");
assert.ok(sessionCookie, "signup did not establish a browser session");
const [tokenA, tokenB] = await Promise.all([authorizeDevice(sessionCookie), authorizeDevice(sessionCookie)]);
runStatecase(machineA, ["login", "--non-interactive", "--device-name", "Daytona workspace restore A"], { token: tokenA });
runStatecase(machineB, ["login", "--non-interactive", "--device-name", "Daytona workspace restore B"], { token: tokenB });
const vault = runStatecase(machineA, ["vault", "create", "Daytona workspace restore UAT", "--recovery-file", recoveryFile], {
  recoveryPassphrase,
});
runStatecase(machineB, ["vault", "join", vault.id, "--recovery-file", recoveryFile], { recoveryPassphrase });

await writeFile(join(source, "tracked.txt"), "baseline historical\n");
await writeFile(join(source, "survives.txt"), "baseline survivor\n");
git(["init", "-q", source]);
git(["-C", source, "add", "tracked.txt", "survives.txt"]);
git(["-C", source, "-c", "user.name=Statecase UAT", "-c", "user.email=uat@statecase.invalid", "commit", "-qm", "historical baseline"]);
git(["-C", source, "branch", "-M", "main"]);
git(["init", "--bare", "-q", remote]);
git(["-C", source, "remote", "add", "origin", `file://${remote}`]);
git(["-C", source, "push", "-q", "-u", "origin", "main"]);
git(["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
const historicalHead = git(["-C", source, "rev-parse", "HEAD"]).stdout.trim();

await writeFile(join(source, "tracked.txt"), "historical index\n");
git(["-C", source, "add", "tracked.txt"]);
await writeFile(join(source, "tracked.txt"), "historical worktree\n");
await writeFile(join(source, "staged.txt"), "historical staged\n");
git(["-C", source, "add", "staged.txt"]);
await writeFile(join(source, "historical-only.txt"), "historical untracked\n");
await symlink("historical-only.txt", join(source, "historical-link"));
const historicalStatus = gitStatus(source);

runStatecase(machineA, ["workspace", "attach", "--id", "ws_restore_uat", "--path", source, "--mode", "git-overlay", "--git-fetch", "auto"]);
const historical = runStatecase(machineA, ["push"]);
const historicalRevisionId = revisionFor(historical, "workspace:ws_restore_uat");

git(["-C", source, "reset", "--hard", "-q", historicalHead]);
await rm(join(source, "historical-only.txt"));
await rm(join(source, "historical-link"));
await writeFile(join(source, "tracked.txt"), "later committed\n");
await writeFile(join(source, "current-base.txt"), "current baseline only\n");
git(["-C", source, "add", "tracked.txt", "current-base.txt"]);
git(["-C", source, "-c", "user.name=Statecase UAT", "-c", "user.email=uat@statecase.invalid", "commit", "-qm", "current baseline"]);
git(["-C", source, "push", "-q", "origin", "main"]);
const currentHead = git(["-C", source, "rev-parse", "HEAD"]).stdout.trim();
assert.notEqual(currentHead, historicalHead);

await writeFile(join(source, "tracked.txt"), "current index\n");
git(["-C", source, "add", "tracked.txt"]);
await writeFile(join(source, "tracked.txt"), "current worktree\n");
await writeFile(join(source, "current-staged.txt"), "current staged\n");
git(["-C", source, "add", "current-staged.txt"]);
await writeFile(join(source, "current-only.txt"), "current untracked\n");
const current = runStatecase(machineA, ["push"]);
const currentRevisionId = revisionFor(current, "workspace:ws_restore_uat");
await writeFile(join(source, "local-only.txt"), "never uploaded\n");
await symlink("local-only.txt", join(source, "local-link"));

const preRestore = await gitSnapshot(source);
assert.equal(preRestore.head, currentHead);
const preview = runStatecase(machineA, [
  "restore", "--revision", historicalRevisionId, "--mapping", "ws_restore_uat", "--in-place", "--dry-run",
]);
assert.equal(preview.mode, "in-place");
assert.equal(preview.dryRun, true);
assert.deepEqual(await gitSnapshot(source), preRestore, "dry-run mutated the Git workspace");

const restored = runStatecase(machineA, [
  "restore", "--revision", historicalRevisionId, "--mapping", "ws_restore_uat", "--in-place", "--yes",
]);
assert.match(restored.protectedSnapshotId, /^snp_/u);
assert.match(restored.emergencySnapshotPath, /\/recovery\/restore_/u);
assert.notEqual(restored.result.revisionId, historicalRevisionId);
assert.notEqual(restored.result.revisionId, currentRevisionId);
await assertHistorical(source, historicalHead, historicalStatus);

git(["clone", "-q", `file://${remote}`, observer]);
runStatecase(machineB, ["workspace", "attach", "--id", "ws_restore_uat", "--path", observer, "--mode", "git-overlay", "--git-fetch", "auto"]);
runStatecase(machineB, ["pull"]);
await assertHistorical(observer, historicalHead, historicalStatus);

const rollback = runStatecase(machineA, ["emergency", "rollback", restored.emergencySnapshotPath, "--yes"], {
  apiUrl: "http://127.0.0.1:1",
});
assert.equal(rollback.restored, true);
assert.deepEqual(await gitSnapshot(source), preRestore, "offline emergency rollback did not restore exact pre-restore Git state");

console.log(JSON.stringify({
  result: "pass",
  email,
  vaultId: vault.id,
  workspaceId: "ws_restore_uat",
  historicalHead,
  currentHead,
  historicalRevisionId,
  currentRevisionId,
  restoredRevisionId: restored.result.revisionId,
  protectedSnapshotId: restored.protectedSnapshotId,
  dryRunNonMutating: true,
  exactHeadIndexWorktreeRestore: true,
  currentOnlyRemovalAndHistoricalResurrection: true,
  independentObserverConverged: true,
  emergencyRollbackOffline: true,
}, null, 2));

async function assertHistorical(directory, expectedHead, expectedStatus) {
  assert.equal(git(["-C", directory, "rev-parse", "HEAD"]).stdout.trim(), expectedHead);
  assert.equal(git(["-C", directory, "symbolic-ref", "HEAD"]).stdout.trim(), "refs/heads/main");
  assert.equal(gitStatus(directory), expectedStatus);
  assert.equal(await readFile(join(directory, "tracked.txt"), "utf8"), "historical worktree\n");
  assert.equal(git(["-C", directory, "show", ":tracked.txt"]).stdout, "historical index\n");
  assert.equal(await readFile(join(directory, "staged.txt"), "utf8"), "historical staged\n");
  assert.equal(await readFile(join(directory, "historical-only.txt"), "utf8"), "historical untracked\n");
  assert.equal(await readlink(join(directory, "historical-link")), "historical-only.txt");
  assert.equal((await lstat(join(directory, "historical-link"))).isSymbolicLink(), true);
  await assertMissing(join(directory, "current-base.txt"));
  await assertMissing(join(directory, "current-staged.txt"));
  await assertMissing(join(directory, "current-only.txt"));
  await assertMissing(join(directory, "local-only.txt"));
  await assertMissing(join(directory, "local-link"));
}

async function gitSnapshot(directory) {
  return {
    head: git(["-C", directory, "rev-parse", "HEAD"]).stdout.trim(),
    headRef: git(["-C", directory, "symbolic-ref", "HEAD"]).stdout.trim(),
    branchRef: git(["-C", directory, "rev-parse", "refs/heads/main"]).stdout.trim(),
    indexDigest: digest(await readFile(join(directory, ".git", "index"))),
    status: gitStatus(directory),
    trackedWorktree: await readFile(join(directory, "tracked.txt"), "utf8"),
    trackedIndex: git(["-C", directory, "show", ":tracked.txt"]).stdout,
    currentBase: await readFile(join(directory, "current-base.txt"), "utf8"),
    currentStaged: await readFile(join(directory, "current-staged.txt"), "utf8"),
    currentOnly: await readFile(join(directory, "current-only.txt"), "utf8"),
    localOnly: await readFile(join(directory, "local-only.txt"), "utf8"),
    localLink: await readlink(join(directory, "local-link")),
  };
}

function revisionFor(result, namespace) {
  assert.equal(result.results?.length, 1, `expected one sync result for ${namespace}`);
  const revisionId = result.results[0]?.revisionId;
  assert.match(revisionId, /^srev_/u, `missing revision for ${namespace}`);
  return revisionId;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitStatus(directory) {
  return git(["-C", directory, "status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
}

function git(args, required = true) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (required) {
    assert.equal(result.error, undefined, `git ${args.join(" ")} could not start`);
    assert.equal(result.status, 0, `git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return result;
}

function runStatecase(statecaseHome, args, secrets = {}) {
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

async function assertMissing(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
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
