import { describe, expect, it } from "vitest";

import {
  classifyClaudePath,
  claudeProjectDirectory,
  resolveClaudeRoot,
  sessionKey,
} from "../src/index.js";

describe("Claude root and workspace mapping (AD-CL-001, AD-CL-002, AD-CL-005)", () => {
  it("uses the default and configured root without consulting the real home", () => {
    expect(resolveClaudeRoot({ home: "/synthetic/home", env: {} })).toBe("/synthetic/home/.claude");
    expect(resolveClaudeRoot({ home: "/synthetic/home", env: { CLAUDE_CONFIG_DIR: "/fixture/claude" } })).toBe(
      "/fixture/claude",
    );
  });

  it("resolves a relative configured root from the supplied cwd", () => {
    expect(
      resolveClaudeRoot({ home: "/synthetic/home", cwd: "/fixture/work", env: { CLAUDE_CONFIG_DIR: "claude-state" } }),
    ).toBe("/fixture/work/claude-state");
  });

  it("maps different absolute paths to distinct native directories but logical session keys stay path-free", () => {
    expect(claudeProjectDirectory("/fixture/claude", "/home/a/project")).not.toBe(
      claudeProjectDirectory("/fixture/claude", "/srv/project"),
    );
    expect(sessionKey({ vaultId: "v", profileId: "p", workspaceId: "w", nativeSessionId: "same" })).toBe(
      "v:claude:p:w:same",
    );
  });

  it.each([
    { vaultId: "", profileId: "p", workspaceId: "w", nativeSessionId: "s" },
    { vaultId: "v:bad", profileId: "p", workspaceId: "w", nativeSessionId: "s" },
  ])("rejects ambiguous session components", (input) => {
    expect(() => sessionKey(input)).toThrow("colon-free");
  });
});

describe("Claude portable-path classification (AD-CL-004, AD-CL-007)", () => {
  it.each([
    ["projects/-home-a-project/session.jsonl", "session"],
    ["skills/demo/SKILL.md", "skill"],
    ["settings.json", "config-filtered"],
    ["CLAUDE.md", "config-filtered"],
    ["memory/notes.md", "config-filtered"],
    ["credentials.json", "credential-excluded"],
    ["debug/latest", "cache-excluded"],
    ["cache/index", "cache-excluded"],
    ["tmp/lock", "cache-excluded"],
    ["future/unknown.bin", "unknown-excluded"],
  ])("classifies %s as %s", (relativePath, expected) => {
    expect(classifyClaudePath(relativePath)).toBe(expected);
  });

  it.each(["", "../credentials.json", "bad\\path", "/absolute/path", "bad\0path"])(
    "rejects unsafe relative path %j",
    (path) => expect(() => classifyClaudePath(path)).toThrow("relative"),
  );
});
