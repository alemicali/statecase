import { describe, expect, it } from "vitest";

import { classifyCodexPath, resolveCodexRoots } from "../src/index.js";

describe("Codex root discovery (AD-CX-001, AD-CX-002)", () => {
  it("uses isolated default roots", () => {
    expect(resolveCodexRoots({ home: "/synthetic/home", env: {} })).toEqual({
      codexHome: "/synthetic/home/.codex",
      sqliteHome: "/synthetic/home/.codex",
    });
  });

  it("honors CODEX_HOME and CODEX_SQLITE_HOME", () => {
    expect(
      resolveCodexRoots({
        home: "/synthetic/home",
        env: { CODEX_HOME: "/fixture/codex", CODEX_SQLITE_HOME: "/fixture/db" },
      }),
    ).toEqual({ codexHome: "/fixture/codex", sqliteHome: "/fixture/db" });
  });

  it("lets config sqlite_home override the environment and resolves relative values from cwd", () => {
    expect(
      resolveCodexRoots({
        home: "/synthetic/home",
        cwd: "/fixture/project",
        env: { CODEX_SQLITE_HOME: "/fixture/env-db" },
        configText: 'sqlite_home = "./codex-db"\n',
      }),
    ).toEqual({
      codexHome: "/synthetic/home/.codex",
      sqliteHome: "/fixture/project/codex-db",
    });
  });
});

describe("Codex portable-path classification (AD-CX-002, AD-CX-006)", () => {
  it.each([
    ["sessions/2026/a.jsonl", "session"],
    ["skills/my-skill/SKILL.md", "skill"],
    ["config.toml", "config-filtered"],
    ["auth.json", "credential-excluded"],
    ["state.db", "live-db-excluded"],
    ["state.db-wal", "live-db-excluded"],
    ["logs/tui.log", "cache-excluded"],
    ["bin/codex", "binary-excluded"],
    ["future/native.data", "unknown-excluded"],
  ])("classifies %s as %s", (relativePath, expected) => {
    expect(classifyCodexPath(relativePath)).toBe(expected);
  });

  it("rejects traversal-shaped relative paths", () => {
    expect(() => classifyCodexPath("../auth.json")).toThrow("relative");
  });
});
