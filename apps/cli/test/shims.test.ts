import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { installHarnessShim, removeHarnessShim, verifyHarnessShim } from "../src/shims.js";

const temporary: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("transparent harness shims (RT-001, RT-012, IS-005)", () => {
  it("atomically installs an owner-executable shim with exact real paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-shim-"));
    temporary.push(root);
    const shimPath = join(root, "bin", "codex");
    const statecase = join(root, "statecase's bin");
    const realHarness = join(root, "real codex");

    const result = await installHarnessShim({ harness: "codex", shimPath, statecaseExecutable: statecase, realExecutable: realHarness });

    expect(result).toMatchObject({ created: true, shimPath, realExecutable: realHarness });
    expect(await verifyHarnessShim(shimPath)).toBe(true);
    const contents = await readFile(shimPath, "utf8");
    expect(contents).toContain("# statecase-shim-v1 harness=codex");
    expect(contents).toContain(`${root}/statecase'"'"'s bin'`);
    expect(contents).toContain(`'${realHarness}'`);
    if (process.platform !== "win32") expect((await stat(shimPath)).mode & 0o777).toBe(0o700);
    expect((await installHarnessShim({ harness: "codex", shimPath, statecaseExecutable: statecase, realExecutable: realHarness })).created).toBe(false);
    expect((await installHarnessShim({ harness: "codex", shimPath, statecaseExecutable: statecase, realExecutable: `${realHarness}-new` })).created).toBe(true);
    await expect(installHarnessShim({ harness: "codex", shimPath, statecaseExecutable: statecase, realExecutable: shimPath }))
      .rejects.toThrow("resolves to the shim");
  });

  it("never overwrites or removes a non-Statecase executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-shim-owned-"));
    temporary.push(root);
    const shimPath = join(root, "codex");
    await writeFile(shimPath, "#!/bin/sh\necho user-owned\n", "utf8");
    await chmod(shimPath, 0o755);

    await expect(installHarnessShim({ harness: "codex", shimPath, statecaseExecutable: "/statecase", realExecutable: "/real" }))
      .rejects.toThrow("refusing to replace");
    await expect(removeHarnessShim(shimPath)).rejects.toThrow("refusing to remove");
    expect(await readFile(shimPath, "utf8")).toContain("user-owned");
  });

  it("removes only an intact Statecase shim and treats absence idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "statecase-shim-remove-"));
    temporary.push(root);
    const shimPath = join(root, "nested", "claude");
    await mkdir(join(root, "nested"));
    await installHarnessShim({ harness: "claude", shimPath, statecaseExecutable: "/statecase", realExecutable: "/real-claude" });
    expect(await removeHarnessShim(shimPath)).toBe(true);
    expect(await verifyHarnessShim(shimPath)).toBe(false);
    expect(await removeHarnessShim(shimPath)).toBe(false);
  });
});
