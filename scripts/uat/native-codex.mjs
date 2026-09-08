import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildNativeScenario } from "./build-native-scenario.mjs";

// Build the actual engine into a disposable test executable; no fixture provider
// or reference transport is distributed in the product package.
assert.ok(process.env.STATECASE_UAT_CODEX, "set the absolute native Codex executable");
const directory = await mkdtemp(join(tmpdir(), "statecase-native-driver-"));
try {
  const outfile = join(directory, "scenario.mjs");
  await buildNativeScenario(resolve(dirname(fileURLToPath(import.meta.url)), "native-codex-scenario.mjs"), outfile);
  const pending = promisify(execFile)(process.execPath, [outfile], {
    env: process.env, timeout: 180_000, maxBuffer: 1024 * 1024,
  });
  pending.child.stdin.end();
  const result = await pending;
  process.stdout.write(result.stdout);
} catch (error) {
  // Do not expose native diagnostics, command arguments, or fixture transcripts.
  let phase, preferenceFailure, preferenceProbe, nativeError, nativeFailure, requests;
  for (const line of String(error.stderr ?? "").split("\n")) {
    try {
      const record = JSON.parse(line);
      if (["setup", "native-source", "encrypted-transfer", "native-resume", "return-publish", "return-pull", "native-preferences"].includes(record.phase)) phase = record.phase;
      if (["NATIVE_MODEL_MISMATCH", "NATIVE_EFFORT_MISMATCH"].includes(record.preferenceFailure)) preferenceFailure = record.preferenceFailure;
      if (["synced", "override"].includes(record.preferenceProbe)) preferenceProbe = record.preferenceProbe;
      if (["Error", "AssertionError"].includes(record.error)) nativeError = record.error;
      if (["NATIVE_SESSION_ID_INVALID", "NATIVE_SESSION_REUSED", "NATIVE_CONFIG_CHANGED", "NATIVE_TURN_INCOMPLETE"].includes(record.nativeFailure)) nativeFailure = record.nativeFailure;
      if (Number.isInteger(record.requests) && record.requests >= 0 && record.requests <= 4) requests = record.requests;
    } catch { /* Only explicitly allowlisted phase metadata may leave the child. */ }
  }
  process.stderr.write(`${JSON.stringify({ result: "fail", phase, preferenceFailure, preferenceProbe, nativeError, nativeFailure, requests, error: error.name, code: error.code })}\n`);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
