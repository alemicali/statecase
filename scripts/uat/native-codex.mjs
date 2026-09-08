import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

// Build the actual engine into a disposable test executable; no fixture provider
// or reference transport is distributed in the product package.
assert.ok(process.env.STATECASE_UAT_CODEX, "set the absolute native Codex executable");
const directory = await mkdtemp(join(tmpdir(), "statecase-native-driver-"));
try {
  const outfile = join(directory, "scenario.mjs");
  await build({
    entryPoints: [resolve(dirname(fileURLToPath(import.meta.url)), "native-codex-scenario.mjs")],
    outfile, bundle: true, platform: "node", format: "esm", external: ["better-sqlite3"],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const pending = promisify(execFile)(process.execPath, [outfile], {
    env: process.env, timeout: 180_000, maxBuffer: 1024 * 1024,
  });
  pending.child.stdin.end();
  const result = await pending;
  process.stdout.write(result.stdout);
} catch (error) {
  // Do not expose native diagnostics, command arguments, or fixture transcripts.
  process.stderr.write(`${JSON.stringify({ result: "fail", error: error.name, code: error.code })}\n`);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
