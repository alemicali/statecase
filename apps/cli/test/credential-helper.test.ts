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

  it("redacts timeout/locked helper errors and wipes captured stdout/stderr", async () => {
    stdout = Buffer.from("secret stdout"); stderr = Buffer.from("secret stderr"); error = new Error("secret native error");
    const protector = nativeCredentialProtector("linux");
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

  it("refuses unsupported platforms and invalid key identities before any helper call", async () => {
    expect(() => nativeCredentialProtector("darwin")).toThrow("not supported");
    expect(() => nativeCredentialProtector("win32")).toThrow("not supported");
    const protector = nativeCredentialProtector("linux");
    await expect(protector.get("not-an-id")).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    await expect(protector.put("not-an-id", Buffer.alloc(32))).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    await expect(protector.put(id, Buffer.alloc(31))).rejects.toMatchObject({ code: "CREDENTIAL_KEY_MISMATCH" });
    expect(calls).toHaveLength(0);
  });
});
