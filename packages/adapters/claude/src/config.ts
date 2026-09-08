import type { SettingRule } from "@statecase/adapter-common/config";
import type { SettingsDocument } from "@statecase/adapter-common/settings-transport";

const choice = (path: string, values: readonly string[]): SettingRule => ({ path: [path], validate: (value) => typeof value === "string" && values.includes(value) });
const boolean = (path: string): SettingRule => ({ path: [path], validate: (value) => typeof value === "boolean" });

/** Only user settings.json; .claude.json contains machine-owned authority. */
export const claudeSettingsDocument: SettingsDocument = {
  id: "user", nativePath: "settings.json", format: "json",
  rules: [
    { path: ["model"], validate: (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\[1m\])?$/u.test(value) },
    choice("effortLevel", ["low", "medium", "high", "xhigh"]),
    { path: ["language"], validate: (value) => typeof value === "string" && /^[\p{L}\p{M}][\p{L}\p{M} ()_-]{0,79}$/u.test(value) },
    boolean("alwaysThinkingEnabled"), boolean("autoMemoryEnabled"), boolean("verbose"),
    choice("editorMode", ["normal", "vim"]),
    choice("theme", ["auto", "dark", "light", "dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi"]),
  ],
};
