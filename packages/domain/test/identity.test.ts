import { describe, expect, it } from "vitest";

import { normalizeGitRemote, workspaceIdForRemote } from "../src/index.js";

describe("Git workspace identity (ID-001..ID-003, ID-008)", () => {
  it.each([
    "git@GitHub.com:alemicali/statecase.git",
    "ssh://git@github.com/alemicali/statecase",
    "https://github.com/alemicali/statecase.git/",
    "https://token-do-not-retain@GITHUB.COM/alemicali/statecase",
  ])("normalizes equivalent remote %s", (remote) => {
    expect(normalizeGitRemote(remote)).toBe("github.com/alemicali/statecase");
    expect(workspaceIdForRemote(remote)).toBe(workspaceIdForRemote("https://github.com/alemicali/statecase"));
  });

  it("keeps forks distinct", () => {
    expect(workspaceIdForRemote("git@github.com:owner-a/repo.git")).not.toBe(
      workspaceIdForRemote("git@github.com:owner-b/repo.git"),
    );
  });

  it.each([
    ["https://example.com:443/team/repo.git", "example.com/team/repo"],
    ["ssh://git@example.com:22/team/repo", "example.com/team/repo"],
    ["ssh://git@example.com:2222/team/repo", "example.com:2222/team/repo"],
    ["ssh://git@[2001:db8::1]/team/repo", "[2001:db8::1]/team/repo"],
    ["https://example.com/t%C3%A9am/r%C3%A9po.git", "example.com/t%C3%A9am/r%C3%A9po"],
  ])("normalizes edge remote %s", (remote, expected) => {
    expect(normalizeGitRemote(remote)).toBe(expected);
  });

  it.each(["", "not a remote", "file:///tmp/repository", "https://host/", "../repo", "https://example.com/team/%GG"])(
    "rejects unsupported remote %j",
    (remote) => expect(() => normalizeGitRemote(remote)).toThrow("remote"),
  );

  it("never includes credentials or local paths in the workspace ID", () => {
    const id = workspaceIdForRemote("https://user:secret@example.com/team/repo.git");
    expect(id).toMatch(/^ws_[A-Za-z0-9_-]{43}$/u);
    expect(id).not.toContain("secret");
    expect(id).not.toContain("/home/");
  });
});
