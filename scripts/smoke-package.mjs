import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  if (process.platform !== "win32") await access(executable, constants.X_OK);
  const environment = { PATH: process.env.PATH, HOME: join(installation, "user-home"), STATECASE_HOME: join(installation, "home"),
    CODEX_HOME: join(installation, "codex"), CODEX_SQLITE_HOME: join(installation, "sqlite"),
    CLAUDE_CONFIG_DIR: join(installation, "configured-claude") };
  const status = await run(executable, ["--json", "status"], { env: environment, encoding: "utf8" });
  const parsed = JSON.parse(status.stdout);
  if (parsed.authenticated !== false || parsed.accessMode !== "none") throw new Error("packed CLI returned an invalid fresh status");

  const skill = join(installation, "installed-skill");
  await run(executable, ["--json", "skills", "install", "--target", skill], { env: environment });
  await Promise.all([access(join(skill, "SKILL.md")), access(join(skill, "agents", "openai.yaml"))]);
  const skillText = await readFile(join(skill, "SKILL.md"), "utf8");
  if (!skillText.includes("name: statecase")) throw new Error("packed CLI installed the wrong skill");

  // SK-001: the packaged setup and skill lifecycle must agree on native root
  // overrides. Every possible default path is under the synthetic HOME above.
  const setup = JSON.parse((await run(executable, ["--json", "setup", "--harness", "claude"], { env: environment })).stdout);
  const nativeSkill = join(environment.CLAUDE_CONFIG_DIR, "skills", "statecase");
  assert.ok(setup.skillTargets.includes(nativeSkill));
  await access(join(nativeSkill, "SKILL.md"));
  await assert.rejects(access(join(environment.HOME, ".claude")), { code: "ENOENT" });
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
