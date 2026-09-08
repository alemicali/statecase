import { describe, expect, it } from "vitest";
import { patchSettings, projectSettings } from "@statecase/adapter-common/config";
import { codexSettingsDocument } from "../src/config.js";

const bytes = (value: string) => new TextEncoder().encode(value);
describe("Codex portable preferences policy (AD-CFG-004)", () => {
  it("exports reviewed preferences but excludes authority, providers, hooks, profiles and paths", () => {
    const source = 'model="fixture-model"\nreview_model="review-fixture"\nmodel_reasoning_effort="high"\nmodel_reasoning_summary="auto"\nmodel_verbosity="low"\npersonality="pragmatic"\nhide_agent_reasoning=false\nshow_raw_agent_reasoning=true\napproval_policy="never"\nsandbox_mode="danger-full-access"\nmodel_provider="private"\nnotify=["private-command"]\nmodel_instructions_file="/private/instructions"\nprofile="local"\n[model_providers.private]\nenv_key="TOKEN_CANARY"\nbase_url="https://private.invalid"\n[tui]\nanimations=false\nvim_mode_default=true\nshow_tooltips=false\ntheme="fixture-dark"\nalternate_screen="auto"\n[projects."/private/workspace"]\ntrust_level="trusted"\n';
    const fields = projectSettings(bytes(source), "toml", codexSettingsDocument.rules);
    expect(fields).toHaveLength(13);
    expect(fields).toContainEqual({ key: "tui.animations", value: false });
    expect(JSON.stringify(fields)).not.toMatch(/private|TOKEN|approval|sandbox|profile/u);
    const updated = new TextDecoder().decode(patchSettings(bytes(source), "toml", codexSettingsDocument.rules, [{ key: "model", value: "new-model" }]));
    expect(updated).toBe(source.replace('model="fixture-model"', 'model="new-model"'));
    expect(codexSettingsDocument).toMatchObject({ id: "user", nativePath: "config.toml", format: "toml" });
  });
  it.each(['model="https://private.invalid"', 'model="/host/path"', 'model_reasoning_effort="invented"', 'model_verbosity=3', 'tui={animations="true"}', 'tui={theme="../private"}', 'personality="other"'])("fails closed for unsupported known values: %s", (source) => {
    expect(() => projectSettings(bytes(source), "toml", codexSettingsDocument.rules)).toThrow();
  });
});
