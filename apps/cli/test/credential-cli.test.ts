import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliIO } from "../src/bin.js";
import { ConfigStore } from "../src/config.js";
import type { CredentialKeyProtector } from "../src/credentials.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "statecase-credential-cli-")); roots.push(root);
  vi.stubEnv("STATECASE_HOME", root);
  const keys = new Map<string, Uint8Array>(); const output: string[] = []; const errors: string[] = [];
  const protector: CredentialKeyProtector = { backend: "secret-service",
    get: vi.fn(async (id: string) => { const key = keys.get(id); if (!key) throw new Error("never-output-native-canary"); return key.slice(); }),
    put: vi.fn(async (id: string, key: Uint8Array) => { keys.set(id, key.slice()); }) };
  const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value),
    fetch: vi.fn(async () => { throw new Error("unexpected network call"); }), credentialProtector: protector };
  return { root, keys, output, errors, protector, io, command: (...args: string[]) => runCli(["node", "statecase", "--json", ...args], io) };
}

describe("CLI credential lifecycle (AU-012, AU-013, CR-011)", () => {
  it("previews without files/network/native calls and requires unambiguous explicit confirmation", async () => {
    const f = await fixture();
    expect(await f.command("credentials", "status")).toBe(0);
    expect(JSON.parse(f.output.at(-1)!)).toEqual({ backend: "file", protected: false, exists: false });
    expect(await f.command("credentials", "protect")).toBe(2);
    expect(await f.command("credentials", "protect", "--yes", "--dry-run")).toBe(2);
    expect(await f.command("credentials", "protect", "--dry-run")).toBe(0);
    expect(JSON.parse(f.output.at(-1)!)).toEqual({ backend: "secret-service", changed: false, dryRun: true });
    expect(await readdir(f.root)).toEqual([]);
    expect(f.protector.get).not.toHaveBeenCalled(); expect(f.protector.put).not.toHaveBeenCalled(); expect(f.io.fetch).not.toHaveBeenCalled();
  });

  it("protects once, keeps logout encrypted, reports status without opening the native store, and fails closed", async () => {
    const f = await fixture(); const store = new ConfigStore(f.root, { protector: f.protector });
    await store.saveSecrets({ version: 1, token: "credential-cli-token-canary", vaultKeys: { vlt_fixture: "credential-cli-key-canary" } });
    expect(await f.command("credentials", "protect", "--yes")).toBe(0);
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({ changed: true, dryRun: false });
    expect(await f.command("credentials", "protect", "--yes")).toBe(0);
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({ changed: false }); expect(f.keys.size).toBe(1);
    expect(await f.command("logout")).toBe(0);
    expect(await store.loadSecrets()).toEqual({ version: 1, vaultKeys: { vlt_fixture: "credential-cli-key-canary" } });
    const encoded = await readFile(join(f.root, "credentials.json"), "utf8"); expect(JSON.parse(encoded).version).toBe(2);
    f.keys.clear(); vi.mocked(f.protector.get).mockClear();
    expect(await f.command("credentials", "status")).toBe(0);
    expect(JSON.parse(f.output.at(-1)!)).toEqual({ backend: "secret-service", protected: true, exists: true });
    expect(f.protector.get).not.toHaveBeenCalled();
    expect(await f.command("logout")).toBe(7);
    expect(await readFile(join(f.root, "credentials.json"), "utf8")).toBe(encoded);
    for (const canary of ["credential-cli-token-canary", "credential-cli-key-canary", "never-output-native-canary"]) {
      expect([...f.output, ...f.errors, encoded].join("\n")).not.toContain(canary);
    }
    expect(f.io.fetch).not.toHaveBeenCalled();
  });
});
