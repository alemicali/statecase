import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultSkillTargets, installSkill, uninstallSkill, verifySkill } from "../src/skills.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("agent-native skill installer (SK-001)", () => {
  it("uses the configured Claude root instead of an unused default directory (AD-CL-001)", () => {
    expect(defaultSkillTargets({ home: "/fixture/home", env: { CLAUDE_CONFIG_DIR: "/fixture/isolated-claude" } })).toEqual([
      "/fixture/home/.agents/skills/statecase", "/fixture/isolated-claude/skills/statecase",
    ]);
  });

  it("resolves relative Claude overrides against the supplied CWD and preserves defaults", () => {
    expect(defaultSkillTargets({ home: "/fixture/home", cwd: "/fixture/work", env: { CLAUDE_CONFIG_DIR: "native/claude" } })).toEqual([
      "/fixture/home/.agents/skills/statecase", "/fixture/work/native/claude/skills/statecase",
    ]);
    expect(defaultSkillTargets({ home: "/fixture/home", env: {} })).toEqual([
      "/fixture/home/.agents/skills/statecase", "/fixture/home/.claude/skills/statecase",
    ]);
  });

  it("installs, verifies, and explicitly removes the canonical skill in an isolated target", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-skill-"));
    temporary.push(home);
    const target = join(home, "skills", "statecase");
    expect(await installSkill([target])).toEqual([target]);
    await expect(access(join(target, "SKILL.md"))).resolves.toBeUndefined();
    expect(await verifySkill([target])).toEqual([{ path: target, installed: true }]);
    await uninstallSkill([target]);
    expect(await verifySkill([target])).toEqual([{ path: target, installed: false }]);
  });

  it("uses the same isolated environment override for default install, verify, and uninstall", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-skill-override-"));
    temporary.push(home);
    const native = join(home, "configured-claude");
    vi.stubEnv("HOME", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", native);
    const targets = [join(home, ".agents", "skills", "statecase"), join(native, "skills", "statecase")];
    expect(defaultSkillTargets()).toEqual(targets);
    expect(await installSkill()).toEqual(targets);
    expect(await verifySkill()).toEqual(targets.map((path) => ({ path, installed: true })));
    await expect(access(join(home, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await uninstallSkill()).toEqual(targets);
    expect(await verifySkill()).toEqual(targets.map((path) => ({ path, installed: false })));
  });
});
