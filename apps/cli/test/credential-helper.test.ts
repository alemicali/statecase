import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: native.execFile }));
import { nativeCredentialProtector } from "../src/credentials.js";

const id = `loc_${"1".repeat(32)}`;
const calls: Array<{ file: string; args: string[]; options: Record<string, unknown>; input?: Buffer }> = [];
let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), error: Error | null = null;
beforeEach(() => {
  calls.length = 0; stdout = Buffer.alloc(0); stderr = Buffer.alloc(0); error = null;
  native.execFile.mockImplementation((file, args, options, callback) => {
    const call = { file, args, options, input: undefined as Buffer | undefined }; calls.push(call);
    return { stdin: {
      on(_event: string, listener: () => void) { listener(); },
      end(input?: Buffer) { call.input = input === undefined ? undefined : Buffer.from(input); queueMicrotask(() => callback(error, stdout, stderr)); },
    } };
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("bounded native credential helper without a real keychain (AU-012)", () => {
  it("stores macOS keys through one bounded stdin command, never argv, and reads an explicitly selected keychain", async () => {
    vi.stubEnv("STATECASE_KEYCHAIN_PATH", '/fixture/space "name".keychain-db');
    vi.stubEnv("DYLD_INSERT_LIBRARIES", "do-not-inherit"); vi.stubEnv("STATECASE_TOKEN", "do-not-inherit");
    const key = Buffer.alloc(32, 17); const encoded = key.toString("base64url");
    const protector = nativeCredentialProtector("darwin");
    expect(protector.backend).toBe("macos-keychain");
    await protector.put(id, key);
    expect(calls[0]!.file).toBe("/usr/bin/security"); expect(calls[0]!.args).toEqual(["-q", "-i"]);
    expect(calls[0]!.input?.toString()).toContain(`"-w" "${encoded}"`);
    expect(calls[0]!.input?.toString()).toContain('"/fixture/space \\"name\\".keychain-db"');
    expect(calls[0]!.input?.toString().split("\n")).toHaveLength(2);
    expect(calls[0]!.options).toMatchObject({ timeout: 10000, maxBuffer: 4096 });
    expect(calls[0]!.options.env).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
    expect(calls[0]!.options.env).not.toHaveProperty("STATECASE_TOKEN");
    stdout = Buffer.from(`${encoded}\n`);
    expect(await protector.get(id)).toEqual(key);
    // Repeated explicit path forces Apple's non-null array lookup, even if
    // opening that keychain fails. A single failed path can fall back to defaults.
    expect(calls[1]!.args).toEqual(["find-generic-password", "-a", id, "-s", "statecase-local-credentials-v1", "-w", '/fixture/space "name".keychain-db', '/fixture/space "name".keychain-db']);
    expect(calls[1]!.input).toBeUndefined(); expect(stdout.every((byte) => byte === 0)).toBe(true);
  });

  it("uses the system default keychain when no explicit path is configured", async () => {
    vi.stubEnv("STATECASE_KEYCHAIN_PATH", undefined);
    const protector = nativeCredentialProtector("darwin");
    await protector.put(id, Buffer.alloc(32));
    expect(calls[0]!.input?.toString()).not.toContain("keychain-db");
    stdout = Buffer.from(`${Buffer.alloc(32).toString("base64url")}\n`); await protector.get(id);
    expect(calls[1]!.args.at(-1)).toBe("-w");
  });

  // OS environment values cannot contain NUL (Node truncates on assignment).
  it.each(["", "relative.keychain", "/fixture/bad\ncommand", "/fixture/bad\rpath", `/fixture/${"x".repeat(4096)}`])("rejects unsafe macOS keychain path before any native call (%j)", (path) => {
    vi.stubEnv("STATECASE_KEYCHAIN_PATH", path);
    expect(() => nativeCredentialProtector("darwin")).toThrow(); expect(calls).toHaveLength(0);
  });

  it("bounds the escaped command and keeps its selected keychain stable", async () => {
    vi.stubEnv("STATECASE_KEYCHAIN_PATH", "/" + '"'.repeat(2047));
    await expect(nativeCredentialProtector("darwin").put(id, Buffer.alloc(32))).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    expect(calls).toHaveLength(0);
    vi.stubEnv("STATECASE_KEYCHAIN_PATH", "/fixture/first\\path.keychain-db");
    const protector = nativeCredentialProtector("darwin");
    vi.stubEnv("STATECASE_KEYCHAIN_PATH", "/fixture/second.keychain-db");
    await protector.put(id, Buffer.alloc(32));
    expect(calls[0]!.input?.toString()).toContain('"/fixture/first\\\\path.keychain-db"');
    stdout = Buffer.from(Buffer.alloc(32).toString("base64url"));
    await protector.get(id);
    expect(calls[1]!.args.at(-1)).toBe("/fixture/first\\path.keychain-db");
  });

  it.each([`${"A".repeat(43)}\n\n`, `${"A".repeat(43)}\r\n`, " A".repeat(30), "A".repeat(42) + "B\n"])("rejects noncanonical macOS output (%j)", async (value) => {
    stdout = Buffer.from(value);
    await expect(nativeCredentialProtector("darwin").get(id)).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
  });

  it("pipes the key to the system executable, filters the environment, and bounds helper execution", async () => {
    vi.stubEnv("STATECASE_TOKEN", "never-forward-this-token"); vi.stubEnv("LD_PRELOAD", "never-load-this");
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/fixture/private-bus");
    const key = Buffer.alloc(32, 19); const encoded = key.toString("base64url");
    const protector = nativeCredentialProtector("linux");
    await protector.put(id, key);
    expect(calls[0]!.file).toBe("/usr/bin/secret-tool");
    expect(calls[0]!.input?.toString()).toBe(encoded);
    expect(calls[0]!.args).not.toContain(encoded);
    expect(calls[0]!.options).toMatchObject({ timeout: 10000, killSignal: "SIGKILL", maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/private-bus" } });
    expect(calls[0]!.options.env).not.toHaveProperty("STATECASE_TOKEN");
    expect(calls[0]!.options.env).not.toHaveProperty("LD_PRELOAD");
    stdout = Buffer.from(encoded);
    expect(await protector.get(id)).toEqual(key);
    expect(calls[1]!.args[0]).toBe("lookup"); expect(calls[1]!.input).toBeUndefined();
    expect(stdout.every((byte) => byte === 0)).toBe(true);
  });

  it.each(["linux", "darwin"] as const)("redacts %s timeout/locked helper errors and wipes captured stdout/stderr", async (platform) => {
    stdout = Buffer.from("secret stdout"); stderr = Buffer.from("secret stderr"); error = new Error("secret native error");
    const protector = nativeCredentialProtector(platform);
    await expect(protector.get(id)).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    expect(stdout.every((byte) => byte === 0)).toBe(true); expect(stderr.every((byte) => byte === 0)).toBe(true);
    await expect(protector.put(id, Buffer.alloc(32))).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
  });

  it("handles synchronous spawn failure without returning upstream diagnostics", async () => {
    native.execFile.mockImplementation(() => { throw new Error("credential-canary"); });
    await expect(nativeCredentialProtector("linux").get(id)).rejects.toThrow("native credential store is unavailable");
  });

  it.each(["", "x", "A".repeat(42), `${"A".repeat(43)}\n`, "A".repeat(42) + "B"])("rejects invalid key encoding (%s)", async (value) => {
    stdout = Buffer.from(value);
    await expect(nativeCredentialProtector("linux").get(id)).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
  });

  it.each(["linux", "darwin"] as const)("refuses unsupported platforms and invalid %s key identities before any helper call", async (platform) => {
    expect(() => nativeCredentialProtector("win32")).toThrow("not supported");
    const protector = nativeCredentialProtector(platform);
    await expect(protector.get("not-an-id")).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    await expect(protector.put("not-an-id", Buffer.alloc(32))).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    await expect(protector.put(id, Buffer.alloc(31))).rejects.toMatchObject({ code: "CREDENTIAL_KEY_MISMATCH" });
    expect(calls).toHaveLength(0);
  });
});
