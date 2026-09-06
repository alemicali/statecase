import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { randomKey } from "@statecase/crypto";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../src/config.js";
import { readRecoveryKit, writeRecoveryKit } from "../src/recovery.js";

const temporary: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CLI local security and recovery (CR-007, CR-009, AU-011)", () => {
  it("uses the conventional owner-local home when no override is configured", () => {
    const previous = process.env.STATECASE_HOME;
    delete process.env.STATECASE_HOME;
    try {
      expect(new ConfigStore().home).toBe(join(homedir(), ".statecase"));
    } finally {
      if (previous === undefined) delete process.env.STATECASE_HOME;
      else process.env.STATECASE_HOME = previous;
    }
  });

  it("writes configuration and credentials atomically with owner-only permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-config-"));
    temporary.push(home);
    const store = new ConfigStore(home);
    await store.saveConfig({ version: 1, apiUrl: "https://example.test", mappings: [], workspaces: [], applied: {} });
    await store.saveSecrets({ version: 1, token: "do-not-print", vaultKeys: { vlt_one: "secret" } });
    if (process.platform !== "win32") {
      expect((await stat(join(home, "config.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, "credentials.json"))).mode & 0o777).toBe(0o600);
    }
    expect((await store.loadSecrets()).token).toBe("do-not-print");
  });

  it("fails closed instead of replacing malformed local configuration", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-malformed-config-"));
    temporary.push(home);
    await writeFile(join(home, "config.json"), "{not-json", "utf8");
    await expect(new ConfigStore(home).loadConfig()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("round-trips a passphrase-protected kit and rejects the wrong vault or passphrase", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-recovery-"));
    temporary.push(home);
    const path = join(home, "recovery.json");
    const key = await randomKey();
    await writeRecoveryKit(path, "vlt_one", key, "correct horse battery staple");
    expect(await readRecoveryKit(path, "vlt_one", "correct horse battery staple")).toEqual(key);
    await expect(readRecoveryKit(path, "vlt_two", "correct horse battery staple")).rejects.toThrow(/does not match/u);
    await expect(readRecoveryKit(path, "vlt_one", "a completely wrong password")).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(await readFile(path, "utf8")).not.toContain(Buffer.from(key).toString("base64url"));
  });
});
