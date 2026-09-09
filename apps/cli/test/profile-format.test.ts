import { describe, expect, it } from "vitest";
import { CLIENT_CAPABILITIES } from "@statecase/protocol";
import { decodeProfile, encodeProfile, PROFILE_MAGIC } from "../src/profile-format.js";

const config = { version: 1 as const, apiUrl: "https://fixture.test", mappings: [], workspaces: [], applied: {}, futureOptional: { keep: true } };
describe("local profile contract and downgrade fence (PR-014, RT-017)", () => {
  it("round-trips current data while making legacy JSON readers fail before interpreting it", () => {
    const text = encodeProfile(config);
    expect(text.startsWith(PROFILE_MAGIC)).toBe(true);
    expect(() => JSON.parse(text)).toThrow();
    expect(decodeProfile(text)).toEqual({ format: 2, config });
  });
  it("recognizes legacy documents for explicit migration without rewriting their optional fields", () => {
    expect(decodeProfile(JSON.stringify(config))).toEqual({ format: 1, config });
    expect(decodeProfile(JSON.stringify({ version: 1, apiUrl: config.apiUrl, mappings: [], applied: {} })).config.workspaces).toEqual([]);
  });
  it.each([null, [], "private-canary", { ...config, version: 8 }, { ...config, mappings: {} },
    { ...config, applied: [] }, { ...config, workspaces: [{ id: "ws", path: 1 }] }, { ...config, runtime: { harnesses: { codex: { realExecutable: 3 } } } }])("rejects malformed or future payloads without their contents: %j", (value) => {
    expect(() => decodeProfile(JSON.stringify(value))).toThrowError(/local profile/u);
    try { decodeProfile(JSON.stringify(value)); } catch (error) { expect(String(error)).not.toContain("private-canary"); }
  });
  it("rejects future frames, required features, incompatible floors and malformed envelopes", () => {
    const envelope = { version: 2, minimumClientContract: 1, requiredCapabilities: CLIENT_CAPABILITIES, config };
    for (const text of ["STATECASE-PROFILE/3\n{}", "{private-canary", PROFILE_MAGIC + "null",
      PROFILE_MAGIC + JSON.stringify({ ...envelope, version: 3 }),
      PROFILE_MAGIC + JSON.stringify({ ...envelope, minimumClientContract: 2 }),
      PROFILE_MAGIC + JSON.stringify({ ...envelope, requiredCapabilities: ["unknown-required"] }),
      PROFILE_MAGIC + JSON.stringify({ ...envelope, requiredCapabilities: ["native-context-v1", "native-context-v1"] })]) {
      expect(() => decodeProfile(text)).toThrowError(/local profile/u);
    }
    expect(decodeProfile(PROFILE_MAGIC + JSON.stringify({ ...envelope, futureOptional: true })).config).toEqual(config);
  });
  it("bounds decoding/encoding and redacts invalid or cyclic output", () => {
    expect(() => decodeProfile(" ".repeat(16 * 1024 * 1024 + 1))).toThrowError(/local profile/u);
    expect(() => encodeProfile({ ...config, deviceName: "x".repeat(16 * 1024 * 1024) })).toThrowError(/local profile/u);
    expect(() => encodeProfile({ ...config, version: 9 } as unknown as typeof config)).toThrowError(/local profile/u);
    const cyclic = { ...config, extra: {} as unknown }; cyclic.extra = cyclic;
    expect(() => encodeProfile(cyclic)).toThrowError(/local profile/u);
  });
});
