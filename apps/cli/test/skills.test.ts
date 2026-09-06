import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installSkill, uninstallSkill, verifySkill } from "../src/skills.js";

const temporary: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("agent-native skill installer (SK-001)", () => {
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
});
