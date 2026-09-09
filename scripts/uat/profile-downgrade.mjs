// RT-017 / PR-014. Real packaged historical CLI, synthetic local state only.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const historicalCommit = "590782901000b40251030f79c722ddd5e1b4eaac";
const root = await mkdtemp(join(tmpdir(), "statecase-profile-binaries-"));
const env = { PATH: process.env.PATH, HOME: join(root, "home"), STATECASE_HOME: join(root, "profile"),
  CODEX_HOME: join(root, "codex"), CODEX_SQLITE_HOME: join(root, "sqlite"), CLAUDE_CONFIG_DIR: join(root, "claude"),
  XDG_CONFIG_HOME: join(root, "xdg"), NPM_CONFIG_USERCONFIG: join(root, "npmrc"), NPM_CONFIG_CACHE: join(root, "npm-cache"),
  NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", WRANGLER_SEND_METRICS: "false" };
let phase = "prepare", evidence;
try {
  for (const path of [env.HOME, env.STATECASE_HOME, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, join(root, "historical")]) await mkdir(path, { mode: 0o700 });
  await writeFile(env.NPM_CONFIG_USERCONFIG, "", { mode: 0o600 });
  phase = "historical-source";
  if ((await command("git", ["cat-file", "-e", `${historicalCommit}^{commit}`], repository)).code !== 0) {
    assert.equal((await command("git", ["fetch", "--no-tags", "--depth=1", "origin", historicalCommit], repository)).code, 0, "historical source acquisition failed");
  }
  const archive = await execute("git", ["archive", historicalCommit], { cwd: repository, env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  await new Promise((accept, reject) => {
    const child = spawn("tar", ["-x", "-C", join(root, "historical")], { env, stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? accept() : reject(new Error("historical extraction failed")));
    child.stdin.end(archive.stdout);
  });
  phase = "build-packages";
  assert.equal((await command("npm", ["ci"], join(root, "historical"))).code, 0, "historical installation failed");
  const binaries = {}, hashes = {};
  for (const [name, source] of [["old", join(root, "historical")], ["current", repository]]) {
    const destination = join(root, name); await mkdir(destination, { mode: 0o700 });
    assert.equal((await command("npm", ["pack", "--workspace", "@statecase/cli", "--pack-destination", destination], source)).code, 0, "CLI packaging failed");
    const packages = (await readdir(destination)).filter((name) => name.endsWith(".tgz")); assert.equal(packages.length, 1);
    const packagePath = join(destination, packages[0]); hashes[name] = createHash("sha256").update(await readFile(packagePath)).digest("hex");
    assert.equal((await command("npm", ["install", "--prefix", destination, packagePath], destination)).code, 0, "clean CLI installation failed");
    binaries[name] = join(destination, "node_modules", "@statecase", "cli", "dist", "bin.js");
  }
  const cli = (name, ...args) => command(process.execPath, [binaries[name], "--json", ...args], root);
  const configPath = join(env.STATECASE_HOME, "config.json"), credentialPath = join(env.STATECASE_HOME, "credentials.json");
  await writeFile(configPath, JSON.stringify({ version: 1, apiUrl: "http://127.0.0.1:1", mappings: [], workspaces: [], applied: {},
    optionalFuture: { preserved: true } }), { mode: 0o600 });
  await writeFile(credentialPath, JSON.stringify({ version: 1, token: "synthetic-private-canary", vaultKeys: {} }), { mode: 0o600 });
  await writeFile(join(env.CODEX_HOME, "sentinel.txt"), "synthetic native bytes", { mode: 0o600 });
  phase = "legacy-usability";
  assert.equal((await cli("old", "status")).code, 0);
  assert.equal((await cli("old", "drop", "add", env.CODEX_HOME, "--name", "legacy-context")).code, 0);
  const original = await readFile(configPath), credentials = await readFile(credentialPath);
  phase = "explicit-upgrade";
  assert.equal((await cli("current", "status")).code, 6);
  const preview = await cli("current", "profile", "upgrade", "--dry-run"); assert.equal(preview.code, 0);
  assert.equal(JSON.parse(preview.stdout).changed, true); assert.deepEqual(await readFile(configPath), original);
  const upgraded = await cli("current", "profile", "upgrade", "--yes"); assert.equal(upgraded.code, 0);
  const backupPath = JSON.parse(upgraded.stdout).backupPath;
  assert.equal(dirname(backupPath), env.STATECASE_HOME); assert.deepEqual(await readFile(backupPath), original);
  const current = await readFile(configPath);
  assert.equal((await cli("current", "status")).code, 0);
  const beforeNames = (await readdir(env.STATECASE_HOME)).sort();
  phase = "historical-downgrade-refusal";
  const operations = [["status"], ["push"], ["pull"], ["sync"], ["setup", "--harness", "codex"],
    ["drop", "add", env.CLAUDE_CONFIG_DIR, "--name", "refused"],
    ["workspace", "attach", "--id", "ws_refused", "--path", env.CLAUDE_CONFIG_DIR, "--mode", "metadata-only"]];
  for (const args of operations) {
    const result = await cli("old", ...args); assert.notEqual(result.code, 0, "historical command unexpectedly accepted the new profile");
    assert.ok(!`${result.stdout}${result.stderr}`.includes("synthetic-private-canary"), "private diagnostic exposure");
    assert.deepEqual(await readFile(configPath), current); assert.deepEqual(await readFile(credentialPath), credentials);
    assert.deepEqual((await readdir(env.STATECASE_HOME)).sort(), beforeNames);
    assert.deepEqual(await readdir(env.CLAUDE_CONFIG_DIR), []);
    assert.deepEqual(await readdir(env.CODEX_HOME), ["sentinel.txt"]);
    assert.equal(await readFile(join(env.CODEX_HOME, "sentinel.txt"), "utf8"), "synthetic native bytes");
  }
  assert.equal((await cli("current", "profile", "upgrade", "--yes")).code, 0);
  evidence = { result: "pass", historicalCommit, tarballSha256: hashes, cleanInstalledPackages: true,
    legacyUsability: true, explicitUpgrade: true, exactBackup: true, historicalCommandsRefused: operations.length,
    profileCredentialsAndNativeFilesPreserved: true,
    boundary: "stopped synthetic profile; config-dependent historical commands only; no live cloud, real harness, active legacy writer or arbitrary old credential/skill commands qualified" };
} catch {
  console.error(JSON.stringify({ result: "fail", phase, failure: "ProfileCompatibilityQualificationFailed" })); process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true }); await assert.rejects(stat(root), { code: "ENOENT" });
}
if (evidence) console.log(JSON.stringify({ ...evidence, cleanupVerified: true }));

async function command(file, args, cwd) {
  try { const result = await execute(file, args, { cwd, env, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }); return { code: 0, ...result }; }
  catch (error) { return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; }
}
