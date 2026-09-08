// AU-012/AU-013/CR-011. Only a disposable macOS runner; every native command
// names an owned temporary keychain. Never inspect or change the default store.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

assert.equal(process.platform, "darwin");
assert.equal(process.env.STATECASE_UAT_CONFIRM, "isolated-native-credentials");
const cli = await realpath(resolve(process.env.STATECASE_UAT_CLI ?? "apps/cli/dist/bin.js"));
const root = await realpath(await mkdtemp("/tmp/statecase-macos-credentials-"));
const keychain = join(root, 'fixture "quoted".keychain-db');
const env = { PATH: "/usr/bin:/bin", HOME: join(root, "home"), STATECASE_HOME: join(root, "profile"),
  STATECASE_KEYCHAIN_PATH: keychain, CODEX_HOME: join(root, "codex-unused"),
  CODEX_SQLITE_HOME: join(root, "sqlite-unused"), CLAUDE_CONFIG_DIR: join(root, "claude-unused"), LANG: "C.UTF-8" };
const credentials = join(env.STATECASE_HOME, "credentials.json");
const token = randomBytes(32).toString("base64url"), vaultKey = randomBytes(32).toString("base64url"), password = randomBytes(32).toString("base64url");
let stage = "prepare", created = false, failure, cleaned = false;
const command = async (args, selectedKeychain = keychain) => {
  const result = await execute(process.execPath, [cli, "--json", ...args], { ...env, STATECASE_KEYCHAIN_PATH: selectedKeychain });
  for (const canary of [token, vaultKey, password]) assert.ok(!`${result.stdout}\n${result.stderr}`.includes(canary), "secret in CLI diagnostics");
  return { code: result.code, data: JSON.parse(result.stdout.trim() || "null") };
};
const native = async (tokens) => {
  // No shell and no secret in process argv; one command followed by EOF.
  const input = Buffer.from(tokens.map((token) => `"${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(" ") + "\n");
  try { return await execute("/usr/bin/security", ["-q", "-i"], env, input); }
  finally { input.fill(0); }
};
try {
  await Promise.all([env.HOME, env.STATECASE_HOME].map((path) => mkdir(path, { mode: 0o700 })));
  await writeFile(credentials, JSON.stringify({ version: 1, token, vaultKeys: { vlt_native_fixture: vaultKey } }), { mode: 0o600, flag: "wx" });
  await writeFile(join(env.STATECASE_HOME, "config.json"), JSON.stringify({ version: 1, apiUrl: "http://127.0.0.1:1", mappings: [], workspaces: [], applied: {} }), { mode: 0o600, flag: "wx" });
  const original = await readFile(credentials);
  stage = "preview-and-missing-store";
  assert.equal((await command(["credentials", "protect", "--dry-run"])).data?.backend, "macos-keychain");
  assert.ok((await readFile(credentials)).equals(original), "preview changed credentials");
  await assert.rejects(stat(keychain), { code: "ENOENT" });
  assert.equal((await command(["credentials", "protect", "--yes"])).code, 7);
  assert.ok((await readFile(credentials)).equals(original), "missing-store migration changed credentials");

  stage = "create-owned-keychain";
  // Creation adds only this new keychain to the OS search list; exact deletion
  // below removes that entry. No list/default-keychain command is used.
  created = true; // cleanup also covers an ambiguous create response
  assert.equal((await native(["create-keychain", "-p", password, keychain])).code, 0);
  assert.equal((await native(["unlock-keychain", "-p", password, keychain])).code, 0);
  stage = "migration-and-reopen";
  assert.equal((await command(["credentials", "protect", "--yes"])).data?.changed, true);
  const encrypted = await readFile(credentials, "utf8"); const document = JSON.parse(encrypted);
  assert.equal(document.backend, "macos-keychain"); assert.equal(document.version, 2);
  assert.equal((await stat(credentials)).mode & 0o777, 0o600);
  for (const canary of [token, vaultKey, password]) assert.ok(!encrypted.includes(canary), "plaintext in protected file");
  assert.equal((await command(["vault", "select", "vlt_native_fixture"])).code, 0);
  assert.equal((await command(["credentials", "protect", "--yes"])).data?.changed, false);

  stage = "explicit-keychain-isolation";
  // The actual item remains in a search-listed fixture keychain. Selecting a
  // missing different path must not find it through the default search list.
  assert.equal((await command(["logout"], join(root, "absent.keychain-db"))).code, 7);
  assert.ok((await readFile(credentials, "utf8")) === encrypted, "wrong-keychain write changed credentials");
  stage = "locked-store";
  assert.equal((await native(["lock-keychain", keychain])).code, 0);
  assert.equal((await command(["credentials", "status"])).data?.protected, true);
  assert.equal((await command(["logout"])).code, 7);
  assert.ok((await readFile(credentials, "utf8")) === encrypted, "locked-store write changed credentials");
  stage = "unlock-and-encrypted-update";
  assert.equal((await native(["unlock-keychain", "-p", password, keychain])).code, 0);
  assert.equal((await command(["vault", "select", "vlt_native_fixture"])).code, 0);
  assert.equal((await command(["logout"])).code, 0);
  const updated = await readFile(credentials, "utf8");
  assert.equal(JSON.parse(updated).backend, "macos-keychain");
  assert.ok(updated !== encrypted, "logout did not persist");
  assert.equal((await command(["vault", "select", "vlt_native_fixture"])).code, 0);
  stage = "deleted-keychain";
  assert.equal((await native(["delete-keychain", keychain])).code, 0); created = false;
  assert.equal((await command(["logout"])).code, 7);
  assert.ok((await readFile(credentials, "utf8")) === updated, "deleted-store write changed credentials");
} catch { failure = stage; }
finally {
  try {
    if (created) assert.equal((await native(["delete-keychain", keychain])).code, 0);
    await rm(root, { recursive: true, force: true });
    await assert.rejects(stat(root), { code: "ENOENT" }); cleaned = true;
  } catch { failure ??= "fixture-cleanup"; }
}
if (failure) {
  console.log(JSON.stringify({ result: "fail", stage: failure, fixtureCleanup: cleaned })); process.exitCode = 1;
} else {
  console.log(JSON.stringify({ result: "pass", backend: "macos-keychain", node: process.version,
    explicitKeychain: true, explicitMigration: true, unavailableStorePreservesFile: true,
    lockedStorePreservesFile: true, keychainUnlock: true, encryptedLogout: true,
    independentCliProcesses: true, fixtureCleanup: cleaned,
    boundary: "clean CLI artifact, temporary explicit macOS keychain; no default-keychain access, cloud, OS reboot or independent security review" }));
}

function execute(file, args, environment, input) {
  return new Promise((accept) => {
    const child = execFile(file, args, { env: environment, cwd: root, encoding: "utf8", timeout: 20_000, maxBuffer: 128 * 1024, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      accept({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
    child.stdin.on("error", () => undefined); child.stdin.end(input);
  });
}
