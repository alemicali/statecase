import { access, cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../skills/statecase", import.meta.url));

export function defaultSkillTargets(): string[] {
  return [join(homedir(), ".agents", "skills", "statecase"), join(homedir(), ".claude", "skills", "statecase")];
}

export async function installSkill(targets = defaultSkillTargets()): Promise<string[]> {
  for (const target of targets) {
    await mkdir(dirname(resolve(target)), { recursive: true, mode: 0o700 });
    await cp(source, resolve(target), { recursive: true, force: true });
  }
  return targets.map((target) => resolve(target));
}

export async function verifySkill(targets = defaultSkillTargets()): Promise<Array<{ path: string; installed: boolean }>> {
  return Promise.all(targets.map(async (target) => {
    try {
      await access(join(resolve(target), "SKILL.md"));
      return { path: resolve(target), installed: true };
    } catch {
      return { path: resolve(target), installed: false };
    }
  }));
}

export async function uninstallSkill(targets = defaultSkillTargets()): Promise<string[]> {
  for (const target of targets) await rm(resolve(target), { recursive: true, force: true });
  return targets.map((target) => resolve(target));
}
