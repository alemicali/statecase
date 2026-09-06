import { execFile } from "node:child_process";
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
  const environment = { ...process.env, STATECASE_HOME: join(installation, "home") };
  const status = await run(executable, ["--json", "status"], { env: environment, encoding: "utf8" });
  const parsed = JSON.parse(status.stdout);
  if (parsed.authenticated !== false || parsed.accessMode !== "none") throw new Error("packed CLI returned an invalid fresh status");

  const skill = join(installation, "installed-skill");
  await run(executable, ["--json", "skills", "install", "--target", skill], { env: environment });
  await Promise.all([access(join(skill, "SKILL.md")), access(join(skill, "agents", "openai.yaml"))]);
  const skillText = await readFile(join(skill, "SKILL.md"), "utf8");
  if (!skillText.includes("name: statecase")) throw new Error("packed CLI installed the wrong skill");
} finally {
  await rm(installation, { recursive: true, force: true });
  if (archive) await rm(archive, { force: true });
}
