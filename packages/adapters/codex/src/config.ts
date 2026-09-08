import type { SettingRule } from "@statecase/adapter-common/config";
import type { SettingsDocument } from "@statecase/adapter-common/settings-transport";

const choice = (path: string, values: readonly string[]): SettingRule => ({ path: path.split("."), validate: (value) => typeof value === "string" && values.includes(value) });
const boolean = (path: string): SettingRule => ({ path: path.split("."), validate: (value) => typeof value === "boolean" });
const identifier = (path: string): SettingRule => ({ path: path.split("."), validate: (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) });

/** Reviewed preferences, not a mirror of Codex's complete configuration schema. */
export const codexSettingsDocument: SettingsDocument = {
  id: "user", nativePath: "config.toml", format: "toml",
  rules: [
    identifier("model"), identifier("review_model"),
    choice("model_reasoning_effort", ["minimal", "low", "medium", "high", "xhigh"]),
    choice("model_reasoning_summary", ["auto", "concise", "detailed", "none"]),
    choice("model_verbosity", ["low", "medium", "high"]),
    choice("personality", ["none", "friendly", "pragmatic"]),
    boolean("hide_agent_reasoning"), boolean("show_raw_agent_reasoning"),
    boolean("tui.animations"), boolean("tui.vim_mode_default"), boolean("tui.show_tooltips"),
    identifier("tui.theme"), choice("tui.alternate_screen", ["auto", "always", "never"]),
  ],
};
