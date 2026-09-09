import { describe, expect, it } from "vitest";
import { patchSettings, projectSettings } from "@statecase/adapter-common/config";
import { claudeSettingsDocument } from "../src/config.js";

const bytes = (value: string) => new TextEncoder().encode(value);
describe("Claude portable preferences policy (AD-CFG-005)", () => {
  it("exports reviewed settings while preserving credentials, hooks, policy and custom paths locally", () => {
    const source = JSON.stringify({ model: "fixture-model[1m]", effortLevel: "high", language: "Italiano", alwaysThinkingEnabled: true, autoMemoryEnabled: true, theme: "dark", editorMode: "vim", verbose: false,
      env: { API_TOKEN: "private-canary" }, permissions: { defaultMode: "bypassPermissions" }, apiKeyHelper: "/private/get-key", hooks: { Stop: [{ command: "/private/hook" }] }, autoMemoryDirectory: "/private/memory", modelOverrides: { fixture: "private-provider" }, modelSettings: { fixture: { effortLevel: "low" } } });
    const fields = projectSettings(bytes(source), "json", claudeSettingsDocument.rules);
    expect(fields).toHaveLength(8);
    expect(fields).toContainEqual({ key: "language", value: "Italiano" });
    expect(JSON.stringify(fields)).not.toMatch(/private|API_TOKEN|permissions|modelSettings/u);
    expect(new TextDecoder().decode(patchSettings(bytes(source), "json", claudeSettingsDocument.rules, [{ key: "theme", value: "light" }]))).toBe(source.replace('"theme":"dark"', '"theme":"light"'));
    expect(claudeSettingsDocument).toMatchObject({ id: "user", nativePath: "settings.json", format: "json" });
  });
  it.each([{ model: "arn:aws:private" }, { model: "https://private.invalid" }, { effortLevel: "invented" }, { theme: "../theme" }, { language: "Italian\n/private" }, { autoMemoryEnabled: "true" }, { editorMode: "command" }])("rejects unsupported known values without falling back to raw JSON", (value) => {
    expect(() => projectSettings(bytes(JSON.stringify(value)), "json", claudeSettingsDocument.rules)).toThrow();
  });
});
