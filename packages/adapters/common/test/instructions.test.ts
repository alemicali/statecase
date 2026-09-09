import { describe, expect, it } from "vitest";
import { instructionLogicalPath, instructionNativePath, validateInstructionSet, type InstructionPolicy } from "../src/instructions.js";

const codex: InstructionPolicy = { files: ["AGENTS.md", "AGENTS.override.md"], trees: [], imports: false };
const claude: InstructionPolicy = { files: ["CLAUDE.md"], trees: ["rules", "instructions"], imports: true };
const bytes = (text: string) => new TextEncoder().encode(text);
const entries = (values: Record<string, string>) => new Map(Object.entries(values).map(([path, text]) => [path, bytes(text)]));

describe("portable instruction policy (AD-CTX-001, AD-CTX-002)", () => {
  it("accepts only reviewed native paths and canonical virtual identities", () => {
    for (const path of codex.files) expect(instructionNativePath(codex, instructionLogicalPath(codex, path))).toBe(path);
    expect(instructionNativePath(claude, "portable-instructions/v1/rules/sub/guide.md")).toBe("rules/sub/guide.md");
    for (const path of ["auth.json", "settings.json", "agents/agent.md", "rules/.hidden.md", "rules/credentials.md", "rules/../CLAUDE.md", "rules//a.md", "rules/a\\b.md", "/CLAUDE.md", "rules/a%20b.md", "rules/a\0b.md"]) expect(() => instructionLogicalPath(claude, path)).toThrow();
    for (const path of ["CLAUDE.md", "portable-instructions/v2/CLAUDE.md", "portable-instructions/v1/config.toml"]) expect(instructionNativePath(claude, path)).toBeUndefined();
    expect(() => instructionLogicalPath(codex, "CLAUDE.md")).toThrow();
  });
  it("validates a closed relative import graph without changing instruction bytes", () => {
    const set = entries({ "CLAUDE.md": "Global @instructions/guide.md\n", "instructions/guide.md": "Read @../rules/style.md\n", "rules/style.md": "Synthetic rules\n" });
    const original = structuredClone(set); expect(() => validateInstructionSet(claude, set)).not.toThrow(); expect(set).toEqual(original);
    expect(() => validateInstructionSet(codex, entries({ "AGENTS.md": "Email user@example.test and mention @outside\n" }))).not.toThrow();
  });
  it("does not interpret code spans/fences or email addresses as Claude imports", () => {
    const text = "Contact user@example.test. `@outside` and ``@other``\n```md\n@/private-canary\n```\n~~~\n@~/secret\n~~~\n";
    expect(() => validateInstructionSet(claude, entries({ "CLAUDE.md": text }))).not.toThrow();
    expect(() => validateInstructionSet(claude, entries({ "CLAUDE.md": "```\n@/private-canary" }))).not.toThrow();
  });
  it("rejects missing, external, authority-bearing, ambiguous and cyclic imports with fixed errors", () => {
    for (const ref of ["missing.md", "../../outside.md", "/private-canary", "~/private-canary", "settings.json", "agents/tool.md", "instructions/guide.md?query", "instructions\\guide.md", '"/private-canary"', "'/private-canary'", ""]) {
      try { validateInstructionSet(claude, entries({ "CLAUDE.md": `Use @${ref}` })); throw new Error("did not reject"); }
      catch (error) { expect(error).toMatchObject({ code: "INSTRUCTION_DEPENDENCY_UNRESOLVED" }); expect(String(error)).not.toContain("canary"); }
    }
    expect(() => validateInstructionSet(claude, entries({ "CLAUDE.md": "@instructions/a.md", "instructions/a.md": "@../CLAUDE.md" }))).toThrow();
  });
  it("bounds bytes, file count, total bytes, depth and UTF-8 before accepting a set", () => {
    expect(() => validateInstructionSet(codex, new Map([["AGENTS.md", new Uint8Array([0xff])]]))).toThrow();
    expect(() => validateInstructionSet(codex, entries({ "AGENTS.md": "bad\0text" }))).toThrow();
    expect(() => validateInstructionSet(codex, entries({ "AGENTS.md": "x".repeat(1024 * 1024 + 1) }))).toThrow();
    expect(() => validateInstructionSet(claude, new Map(Array.from({ length: 257 }, (_, i) => [`rules/${i}.md`, bytes("x")])))).toThrow();
    expect(() => validateInstructionSet(claude, new Map(Array.from({ length: 9 }, (_, i) => [`rules/${i}.md`, bytes("x".repeat(1024 * 1024))])))).toThrow();
    const chain = entries({ "CLAUDE.md": "@instructions/0.md", ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`instructions/${i}.md`, i === 4 ? "done" : `@${i + 1}.md`])) });
    expect(() => validateInstructionSet(claude, chain)).toThrow();
    chain.set("instructions/3.md", bytes("done")); expect(() => validateInstructionSet(claude, chain)).not.toThrow();
    expect(() => validateInstructionSet(claude, entries({ "CLAUDE.md": "@rules/a.md ".repeat(4097), "rules/a.md": "done" }))).toThrow();
    expect(() => validateInstructionSet(claude, entries({ "CLAUDE.md": "x`x ".repeat(8193) }))).toThrow();
    const shared = entries({ "CLAUDE.md": "@rules/a.md @rules/b.md", "rules/a.md": "@shared.md", "rules/b.md": "@shared.md", "rules/shared.md": "done" });
    expect(() => validateInstructionSet(claude, shared)).not.toThrow();
  });
});
