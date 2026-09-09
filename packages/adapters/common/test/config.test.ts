import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { patchSettings, projectSettings, type SettingRule } from "../src/config.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);
const rules: SettingRule[] = [
  { path: ["model"], validate: (value) => typeof value === "string" && value.length <= 128 },
  { path: ["tui", "animations"], validate: (value) => typeof value === "boolean" },
  { path: ["tui", "theme"], validate: (value) => typeof value === "string" },
  { path: ["limit"], validate: (value) => Number.isSafeInteger(value) && Number(value) > 0 },
  { path: ["labels"], validate: (value) => Array.isArray(value) && value.every((item) => typeof item === "string") },
];

describe("portable configuration field projection and lossless patching (AD-CFG-001/002)", () => {
  it.each(["json", "toml"] as const)("projects only allowlisted fields, never secrets or unknown state (%s)", (format) => {
    const source = format === "json"
      ? '{"model":"fixture","env":{"TOKEN":"private-canary"},"unknown":{"model":"not-root"},"tui":{"animations":false},"labels":["one","two"]}'
      : 'model = "fixture"\nenv = {TOKEN = "private-canary"}\nunknown = {model = "not-root"}\nlabels = ["one", "two"]\n[tui]\nanimations = false\n';
    const projected = projectSettings(bytes(source), format, rules);
    expect(projected).toEqual([{ key: "labels", value: ["one", "two"] }, { key: "model", value: "fixture" }, { key: "tui.animations", value: false }]);
    expect(JSON.stringify(projected)).not.toContain("canary");
  });

  it("patches TOML values by syntax ranges, retaining comments, spelling and unknown local values", () => {
    const source = '# operator comment\nmodel  = \'old\' # keep\nlocal = 0xFF\n[tui] # display\nanimations = false\nsecret = \'local-canary\'\n[projects."/local/project"]\ntrust_level = "trusted"\n';
    const updated = text(patchSettings(bytes(source), "toml", rules, [{ key: "model", value: "new" }, { key: "tui.animations", value: true }, { key: "tui.theme", value: "dark" }]));
    expect(updated).toContain('model  = "new" # keep');
    expect(updated).toContain("local = 0xFF"); expect(updated).toContain("secret = 'local-canary'");
    expect(updated).toContain('[projects."/local/project"]\ntrust_level = "trusted"');
    expect(updated).toContain("# operator comment"); expect(updated).toContain("[tui] # display");
    expect(projectSettings(bytes(updated), "toml", rules)).toContainEqual({ key: "tui.theme", value: "dark" });
  });

  it.each([
    'tui = { animations = false, theme = "old", private = 0xFA }',
    'tui.animations = false\ntui.theme = "old"\n[tui.keymap]\nprivate = "keep"',
    '[tui]\nanimations = false\ntheme = "old"\nprivate = "keep"',
    'tui = { theme = "old" }',
    'tui = {}',
    '[tui.keymap]\nprivate = "keep"',
    '',
  ])("inserts and deletes nested TOML fields without redefining tables (%s)", (source) => {
    const updated = patchSettings(bytes(source), "toml", rules, [{ key: "tui.animations", value: true }, { key: "tui.theme" }]);
    expect(projectSettings(updated, "toml", rules)).toEqual([{ key: "tui.animations", value: true }]);
    if (source.includes("private =")) expect(text(updated)).toContain(source.includes("0xFA") ? "private = 0xFA" : 'private = "keep"');
    expect(patchSettings(updated, "toml", rules, [{ key: "tui.animations", value: true }, { key: "tui.theme" }])).toEqual(updated);
  });

  it("preserves untouched JSON lexemes including escaped secrets and large unknown integers", () => {
    const source = '{\n  "model" : "old",\n  "local": 900719925474099312345, "env": {"TOKEN":"\\u0073ecret"}, "tui": {"animations":false,"private":17}\n}';
    const updated = text(patchSettings(bytes(source), "json", rules, [{ key: "model", value: "new" }, { key: "tui.animations" }, { key: "tui.theme", value: "dark" }]));
    expect(updated).toContain('"local": 900719925474099312345'); expect(updated).toContain('"TOKEN":"\\u0073ecret"');
    expect(JSON.parse(updated).tui).toEqual({ private: 17, theme: "dark" });
    expect(JSON.parse(updated).model).toBe("new");
  });

  it.each(["json", "toml"] as const)("handles fresh documents, strings/arrays, deletion and no-op without mutation (%s)", (format) => {
    const updated = patchSettings(undefined, format, rules, [{ key: "model", value: 'quote " newline\n' }, { key: "labels", value: ["one", "two"] }, { key: "limit", value: 7 }]);
    expect(projectSettings(updated, format, rules)).toEqual([{ key: "labels", value: ["one", "two"] }, { key: "limit", value: 7 }, { key: "model", value: 'quote " newline\n' }]);
    expect(patchSettings(updated, format, rules, [])).toEqual(updated);
    const deleted = patchSettings(updated, format, rules, [{ key: "model" }, { key: "labels" }, { key: "limit" }]);
    expect(projectSettings(deleted, format, rules)).toEqual([]);
  });

  it.each([
    ["json", '{"model":"first","model":"second"}'],
    ["json", '{"env":{"TOKEN":"a","\\u0054OKEN":"b"}}'],
    ["json", '{"model":"canary",}'], ["json", '//canary\n{}'], ["json", '[]'],
    ["toml", 'model="canary"\nmodel="duplicate"'], ["toml", 'model="canary'],
    ["toml", 'limit=9223372036854775807'], ["toml", 'model={token="canary"}'],
    ["json", '{"model":{"token":"canary"}}'],
  ] as const)("rejects malformed/ambiguous/invalid native input without diagnostics (%s)", (format, source) => {
    for (const action of [() => projectSettings(bytes(source), format, rules), () => patchSettings(bytes(source), format, rules, [{ key: "model", value: "new" }])]) {
      try { action(); throw new Error("unexpected success"); } catch (error) {
        expect(error).toMatchObject({ code: "CONFIG_FORMAT_INVALID" }); expect(String(error)).not.toContain("canary");
      }
    }
  });

  it.each(["json", "toml"] as const)("rejects untrusted fields, duplicate patches, bad values and resource excess (%s)", (format) => {
    const source = bytes(format === "json" ? "{}" : "");
    for (const patches of [[{ key: "env.TOKEN", value: "canary" }], [{ key: "model", value: {} }], [{ key: "model", value: "x" }, { key: "model", value: "y" }], [{ key: "__proto__.polluted", value: true }]]) {
      expect(() => patchSettings(source, format, rules, patches)).toThrow();
    }
    expect(() => projectSettings(new Uint8Array([255]), format, rules)).toThrow();
    expect(() => projectSettings(bytes(" ".repeat(1024 * 1024 + 1)), format, rules)).toThrow();
    expect(() => patchSettings(source, format, rules, [{ key: "model", value: "x".repeat(129) }])).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(["json", "toml"] as const)("rejects scalar ancestors instead of silently treating known settings as absent (%s)", (format) => {
    const source = format === "json" ? '{"tui":42}' : "tui = 42";
    expect(() => projectSettings(bytes(source), format, rules)).toThrow();
    expect(() => patchSettings(bytes(source), format, rules, [{ key: "tui.theme", value: "new" }])).toThrow();
  });

  it("bounds parser depth, node count, policy shape and output size", () => {
    for (const [format, source] of [
      ["json", '{"unknown":' + "[".repeat(70) + "0" + "]".repeat(70) + "}"],
      ["toml", "unknown=" + "[".repeat(70) + "0" + "]".repeat(70)],
      ["json", '{"unknown":[' + "0,".repeat(20_000) + "0]}"],
      ["toml", "unknown=[" + "0,".repeat(20_000) + "0]"],
    ] as const) expect(() => projectSettings(bytes(source), format, rules)).toThrow();
    for (const paths of [[[]], [["constructor"]], [["a", "bad-key"]], [["a"], ["a"]], [["a"], ["a", "b"]], Array.from({ length: 129 }, (_, i) => [`field${i}`])]) {
      expect(() => projectSettings(bytes("{}"), "json", paths.map((path) => ({ path, validate: () => true })))).toThrow();
    }
    const source = bytes("#" + "x".repeat(1024 * 1024 - 4) + "\n");
    expect(() => patchSettings(source, "toml", rules, [{ key: "model", value: "added" }])).toThrow();
    expect(() => projectSettings(bytes("[model]\nvalue=1"), "toml", rules)).toThrow();
  });

  it("does not parse apparent fields inside comments, strings, array tables or escaped literal keys", () => {
    const source = '# model="ignored"\nsecret = """\nmodel="ignored"\n"""\n"tui.animations"=42\n[[agents]]\nmodel="not-root"\n';
    expect(projectSettings(bytes(source), "toml", rules)).toEqual([]);
    const unicode = '# 🌊 native comment\n"mod\\u0065l" = "old"\n';
    expect(text(patchSettings(bytes(unicode), "toml", rules, [{ key: "model", value: "new" }]))).toBe('# 🌊 native comment\n"mod\\u0065l" = "new"\n');
    const json = '{"__proto__":{"polluted":"keep-local"},"mod\\u0065l":"old"}';
    expect(text(patchSettings(bytes(json), "json", rules, [{ key: "model", value: "new" }]))).toContain('"__proto__":{"polluted":"keep-local"}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    'tui={theme="old", animations=false}', 'tui={animations=false, theme="old"}',
    'tui={theme="old"}', '[tui] # header without newline',
    'tui={keymap={private="keep"}}',
  ])("handles inline deletion delimiters and header-only insertion (%s)", (source) => {
    const updated = patchSettings(bytes(source), "toml", rules, [{ key: "tui.theme" }, { key: "tui.animations", value: true }]);
    expect(projectSettings(updated, "toml", rules)).toEqual([{ key: "tui.animations", value: true }]);
  });

  it.each(["json", "toml"] as const)("preserves a UTF-8 BOM on no-op and edited documents (%s)", (format) => {
    const source = bytes("\uFEFF" + (format === "json" ? '{"model":"old"}' : 'model="old"'));
    expect(patchSettings(source, format, rules, [])).toEqual(source);
    const updated = patchSettings(source, format, rules, [{ key: "model", value: "new" }]);
    expect(Array.from(updated.slice(0, 3))).toEqual([239, 187, 191]);
    expect(projectSettings(updated, format, rules)).toEqual([{ key: "model", value: "new" }]);
  });

  it("round-trips randomized values without changing unknown TOML lexemes", () => {
    fc.assert(fc.property(fc.string({ maxLength: 60 }), fc.array(fc.string({ maxLength: 30 }), { maxLength: 20 }), fc.boolean(), (model, labels, animations) => {
      const original = bytes('# retained comment\nunknown=9007199254740993\nmodel="old"\n[tui]\nprivate="keep"\n');
      const updated = patchSettings(original, "toml", rules, [{ key: "model", value: model }, { key: "labels", value: labels }, { key: "tui.animations", value: animations }]);
      expect(projectSettings(updated, "toml", rules)).toEqual([{ key: "labels", value: labels }, { key: "model", value: model }, { key: "tui.animations", value: animations }]);
      expect(text(updated)).toContain('# retained comment\nunknown=9007199254740993');
      expect(text(updated)).toContain('private="keep"');
    }), { numRuns: 100 });
  });
});
