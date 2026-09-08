import { describe, expect, it } from "vitest";
import { decodeSetting, encodeSetting, projectSettingEntries, resolveSettingPath, type SettingsDocument } from "../src/settings-transport.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const document: SettingsDocument = {
  id: "user", nativePath: "config.toml", format: "toml",
  rules: [{ path: ["model"], validate: (value) => typeof value === "string" && /^[a-z-]{1,40}$/u.test(value) },
    { path: ["tui", "animations"], validate: (value) => typeof value === "boolean" }],
};

describe("versioned portable settings transport (AD-CFG-003)", () => {
  it("projects individual canonical field entries, without native-file secrets", () => {
    const entries = projectSettingEntries(bytes('model="fixture"\nsecret="private-canary"\n[tui]\nanimations=false\n'), document);
    expect(entries.map((entry) => entry.logicalPath)).toEqual(["portable-config/v1/user/model.json", "portable-config/v1/user/tui.animations.json"]);
    expect(entries.map((entry) => new TextDecoder().decode(entry.bytes))).toEqual(['{"value":"fixture","version":1}', '{"value":false,"version":1}']);
    expect(entries.map((entry) => decodeSetting(entry.bytes, resolveSettingPath([document], entry.logicalPath)!))).toEqual(["fixture", false]);
  });

  it("resolves only exact local document and field identities, not sender-supplied native paths", () => {
    expect(resolveSettingPath([document], "skills/x/SKILL.md")).toBeUndefined();
    expect(resolveSettingPath([document], "config.toml")).toBeUndefined();
    expect(resolveSettingPath([document], "portable-config/v1/user/model.json")).toMatchObject({ document, key: "model" });
    for (const path of ["portable-config", "portable-config/v2/user/model.json", "portable-config/v1/other/model.json", "portable-config/v1/user/secret.json", "portable-config/v1/user/../model.json", "portable-config/v1/user/%6dodel.json", "portable-config/v1/user/model.json/", "portable-config/v1/user/model.JSON", "portable-config/v1/user/__proto__.json"]) {
      expect(() => resolveSettingPath([document], path)).toThrow();
    }
  });

  it("rejects noncanonical, mistyped, oversized and extra-field payloads with redacted diagnostics", () => {
    const field = resolveSettingPath([document], "portable-config/v1/user/model.json")!;
    for (const source of ['{"value":"fixture","version":2}', '{"value":"fixture","version":1,"secret":"canary"}', '{"version":1,"value":"fixture"}', '{"value":"fixture","version":1}\n', '{"value":"first","value":"second","version":1}', '{"value":42,"version":1}', '{"value":{},"version":1}', '{"value":"/private/canary","version":1}', '\uFEFF{"value":"fixture","version":1}', 'null', "[]", "canary", " ".repeat(128 * 1024)]) {
      expect(() => decodeSetting(bytes(source), field)).toThrow(expect.objectContaining({ code: "CONFIG_FORMAT_INVALID" }));
      try { decodeSetting(bytes(source), field); } catch (error) { expect(String(error)).not.toContain("canary"); }
    }
    expect(() => decodeSetting(new Uint8Array([255]), field)).toThrow();
    expect(() => encodeSetting(document, "unknown", "fixture")).toThrow();
    expect(() => encodeSetting(document, "model", null)).toThrow();
  });

  it("rejects ambiguous or unsafe local registries before emitting paths", () => {
    for (const variant of [
      { ...document, id: "../user" }, { ...document, nativePath: "../config.toml" },
      { ...document, nativePath: "/config.toml" }, { ...document, nativePath: "a/config.toml" },
      { ...document, rules: [...document.rules, document.rules[0]!] },
    ]) expect(() => projectSettingEntries(bytes('model="fixture"'), variant)).toThrow();
    expect(() => resolveSettingPath([document, document], "portable-config/v1/user/model.json")).toThrow();
  });
});
