import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { buildNativeScenario } from "../scripts/uat/build-native-scenario.mjs";

it("loads a native UAT bundle outside the repository and uses its real SQLite mutex (RT-016)", async () => {
  const root = await mkdtemp(join(tmpdir(), "statecase-driver-load-"));
  try {
    const executable = join(root, "driver.mjs");
    await buildNativeScenario(resolve(import.meta.dirname, "fixtures", "native-driver-smoke.mjs"), executable);
    const result = await promisify(execFile)(process.execPath, [executable], {
      cwd: root, env: { HOME: root, STATECASE_UAT_ROOT: root }, encoding: "utf8", timeout: 10_000,
    });
    expect(JSON.parse(result.stdout)).toEqual({ result: "pass", nativeMutex: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
