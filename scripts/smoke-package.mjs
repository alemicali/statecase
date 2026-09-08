import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");
const smokeRoot = resolve(process.env.STATECASE_PACKAGE_SMOKE_ROOT ?? tmpdir());
await mkdir(smokeRoot, { recursive: true });
const installation = await mkdtemp(join(smokeRoot, "statecase-package-smoke-"));
let archive;

try {
  const packed = await run("npm", ["pack", "--silent", "--workspace", "@statecase/cli"], { cwd: repository, encoding: "utf8" });
  archive = resolve(repository, packed.stdout.trim().split(/\r?\n/u).at(-1));
  await run("npm", ["install", "--prefix", installation, "--no-audit", "--no-fund", archive], { cwd: repository });
  const executable = join(installation, "node_modules", ".bin", process.platform === "win32" ? "statecase.cmd" : "statecase");
  for (const [name, filename] of [["jsonc-parser", "LICENSE.md"], ["toml-eslint-parser", "LICENSE"], ["eslint-visitor-keys", "LICENSE"]]) {
    assert.deepEqual(await readFile(join(installation, "node_modules", "@statecase", "cli", "dist", "third-party", `${name}.LICENSE`)),
      await readFile(join(repository, "node_modules", name, filename)));
  }
  if (process.platform !== "win32") await access(executable, constants.X_OK);
  const environment = { PATH: process.env.PATH, HOME: join(installation, "user-home"), STATECASE_HOME: join(installation, "home"),
    CODEX_HOME: join(installation, "codex"), CODEX_SQLITE_HOME: join(installation, "sqlite"),
    CLAUDE_CONFIG_DIR: join(installation, "configured-claude") };
  const status = await run(executable, ["--json", "status"], { env: environment, encoding: "utf8" });
  const parsed = JSON.parse(status.stdout);
  if (parsed.authenticated !== false || parsed.accessMode !== "none") throw new Error("packed CLI returned an invalid fresh status");

  // RT-006: the installed command is usable without enrollment. A no-op must
  // not create the profile, inspect native harnesses or request credentials.
  for (const option of ["--dry-run", "--yes"]) {
    const recovery = JSON.parse((await run(executable, ["--json", "profile", "recover", option], { env: environment, encoding: "utf8" })).stdout);
    assert.deepEqual(recovery, { pending: false, outcome: "none", targets: 0, dryRun: option === "--dry-run" });
    await assert.rejects(access(environment.STATECASE_HOME), { code: "ENOENT" });
  }

  const skill = join(installation, "installed-skill");
  await run(executable, ["--json", "skills", "install", "--target", skill], { env: environment });
  await Promise.all([access(join(skill, "SKILL.md")), access(join(skill, "agents", "openai.yaml"))]);
  const skillText = await readFile(join(skill, "SKILL.md"), "utf8");
  if (!skillText.includes("name: statecase")) throw new Error("packed CLI installed the wrong skill");
  await access(join(skill, "references", "memory.md"));

  // SK-001: the packaged setup and skill lifecycle must agree on native root
  // overrides. Every possible default path is under the synthetic HOME above.
  const setup = JSON.parse((await run(executable, ["--json", "setup", "--harness", "claude"], { env: environment })).stdout);
  const nativeSkill = join(environment.CLAUDE_CONFIG_DIR, "skills", "statecase");
  assert.ok(setup.skillTargets.includes(nativeSkill));
  await access(join(nativeSkill, "SKILL.md"));
  await assert.rejects(access(join(environment.HOME, ".claude")), { code: "ENOENT" });

  // AD-MEM-007: exercise the actual installed CLI without a service account or
  // native harness process. Selection must not read credentials or move files.
  await run(executable, ["--json", "setup", "--harness", "codex"], { env: environment });
  const memory = join(installation, "native-recall"), rebound = join(installation, "new-recall");
  await mkdir(memory, { mode: 0o700 }); await writeFile(join(memory, "MEMORY.md"), "synthetic recall", { mode: 0o600 });
  const map = ["--json", "memory", "map", "recall", memory, "--kind", "codex-global", "--harness", "harness:codex:default"];
  const configPath = join(environment.STATECASE_HOME, "config.json"), before = await readFile(configPath);
  const preview = JSON.parse((await run(executable, [...map, "--dry-run"], { env: environment })).stdout);
  assert.equal(preview.files, 1); assert.equal(preview.nativeLocationVerified, false);
  assert.deepEqual(await readFile(configPath), before);
  await run(executable, [...map, "--yes"], { env: environment });
  const memories = JSON.parse((await run(executable, ["--json", "memory", "list"], { env: environment })).stdout).memories;
  assert.equal(memories[0].namespace, "memory:recall");
  await run(executable, ["--json", "memory", "map", "recall", rebound, "--yes"], { env: environment });
  await assert.rejects(access(rebound), { code: "ENOENT" });
  await run(executable, ["--json", "memory", "remove", "recall", "--yes"], { env: environment });
  assert.equal(await readFile(join(memory, "MEMORY.md"), "utf8"), "synthetic recall");
  const verified = JSON.parse((await run(executable, ["--json", "skills", "verify"], { env: environment })).stdout);
  assert.equal(verified.valid, true);
  await run(executable, ["--json", "skills", "uninstall", "--yes"], { env: environment });
  await assert.rejects(access(nativeSkill), { code: "ENOENT" });

  if (process.env.STATECASE_PACKAGE_NATIVE_CREDENTIALS === "1") {
    const driver = join(repository, "scripts", "uat", process.platform === "darwin" ? "native-macos-credentials.mjs" : "native-credentials.mjs");
    const native = await run(process.execPath, [driver], {
      cwd: repository, encoding: "utf8", timeout: 120_000,
      env: { PATH: process.env.PATH, STATECASE_UAT_CLI: executable, STATECASE_UAT_CONFIRM: "isolated-native-credentials" },
    });
    const evidence = JSON.parse(native.stdout.trim());
    assert.equal(evidence.result, "pass"); assert.equal(evidence.fixtureCleanup, true);
    process.stdout.write(`${JSON.stringify({ ...evidence, cleanPackageInstallation: true,
      tarballSha256: createHash("sha256").update(await readFile(archive)).digest("hex"),
      driverSha256: createHash("sha256").update(await readFile(driver)).digest("hex") })}\n`);
  }
} finally {
  await rm(installation, { recursive: true, force: true });
  if (archive) await rm(archive, { force: true });
}
