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
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--memory"), "unsupported qualification scenario");
  const outfile = join(directory, "scenario.mjs");
  await buildNativeScenario(resolve(dirname(fileURLToPath(import.meta.url)), process.argv[2] === "--memory" ? "native-claude-memory-scenario.mjs" : "native-claude-scenario.mjs"), outfile);
  const pending = promisify(execFile)(process.execPath, [outfile], {
    env: process.env, timeout: 180_000, maxBuffer: 1024 * 1024,
  });
  pending.child.stdin.end();
  const result = await pending;
  process.stdout.write(result.stdout);
} catch (error) {
  // Raw native output can contain prompts, paths or tool results. Emit only a
  // phase from our fixed vocabulary; never forward the child command/stderr.
  let phase, preferenceFailure, memoryFailure;
  for (const line of String(error.stderr ?? "").split("\n")) {
    try {
      const record = JSON.parse(line);
      if (["setup", "native-source", "encrypted-transfer", "native-resume", "return-publish", "return-pull", "native-preferences"].includes(record.phase)) phase = record.phase;
      if (["memory-source", "memory-transfer", "memory-resume", "memory-target", "memory-return", "memory-recall", "memory-worktree", "memory-subdirectory", "memory-unrelated"].includes(record.phase)) phase = record.phase;
      if (["NATIVE_MODEL_MISMATCH", "NATIVE_EFFORT_MISMATCH", "NATIVE_INSTRUCTIONS_MISMATCH"].includes(record.preferenceFailure)) preferenceFailure = record.preferenceFailure;
      if (["NATIVE_MEMORY_MISMATCH", "health-probe-limit", "unexpected-route", "request-limit", "unexpected-model-turn", "native-tool-failed", "native-topic-not-read", "native-tool-not-offered", "provider-exception", "provider-failed", "model-turn-count", "native-result-failed"].includes(record.fixtureFailure)) memoryFailure = record.fixtureFailure;
      if (["memory-history-call-count", "memory-history-path-not-localized", "memory-original-read-history-lost"].includes(record.fixtureFailure)) memoryFailure = record.fixtureFailure;
    } catch { /* Ignore non-metadata output. */ }
  }
  process.stderr.write(`${JSON.stringify({ result: "fail", phase, preferenceFailure, memoryFailure, error: "NativeQualificationFailed" })}\n`);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
