import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildNativeScenario } from "./build-native-scenario.mjs";

// AD-CL-006. Never point this drill at an existing harness profile. The child
// uses generated homes, an environment allowlist and only Read/Write/Edit tools.
assert.ok(process.env.STATECASE_UAT_CLAUDE && isAbsolute(process.env.STATECASE_UAT_CLAUDE), "set an absolute native Claude executable");
assert.ok(process.env.STATECASE_UAT_PARENT && isAbsolute(process.env.STATECASE_UAT_PARENT), "set an absolute fixture parent");
assert.equal(process.env.STATECASE_UAT_CONFIRM, "run-native-harness-in-disposable-sandbox");
const directory = await mkdtemp(join(tmpdir(), "statecase-native-claude-driver-"));
try {
  const outfile = join(directory, "scenario.mjs");
  await buildNativeScenario(resolve(dirname(fileURLToPath(import.meta.url)), "native-claude-scenario.mjs"), outfile);
  const pending = promisify(execFile)(process.execPath, [outfile], {
    env: process.env, timeout: 180_000, maxBuffer: 1024 * 1024,
  });
  pending.child.stdin.end();
  const result = await pending;
  process.stdout.write(result.stdout);
} catch (error) {
  // Raw native output can contain prompts, paths or tool results. Emit only a
  // phase from our fixed vocabulary; never forward the child command/stderr.
  let phase, preferenceFailure;
  for (const line of String(error.stderr ?? "").split("\n")) {
    try {
      const record = JSON.parse(line);
      if (["setup", "native-source", "encrypted-transfer", "native-resume", "return-publish", "return-pull", "native-preferences"].includes(record.phase)) phase = record.phase;
      if (["NATIVE_MODEL_MISMATCH", "NATIVE_EFFORT_MISMATCH"].includes(record.preferenceFailure)) preferenceFailure = record.preferenceFailure;
    } catch { /* Ignore non-metadata output. */ }
  }
  process.stderr.write(`${JSON.stringify({ result: "fail", phase, preferenceFailure, error: "NativeQualificationFailed" })}\n`);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
