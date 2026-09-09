import { isAbsolute, join, normalize, resolve } from "node:path";

export interface ClaudeRootOptions {
  home: string;
  cwd?: string;
  env: Readonly<Record<string, string | undefined>>;
}

export type ClaudePathClass =
  | "session"
  | "skill"
  | "config-filtered"
  | "credential-excluded"
  | "cache-excluded"
  | "unknown-excluded";

export function resolveClaudeRoot(options: ClaudeRootOptions): string {
  const value = options.env.CLAUDE_CONFIG_DIR ?? join(options.home, ".claude");
  return normalize(isAbsolute(value) ? value : resolve(options.cwd ?? process.cwd(), value));
}

export function claudeProjectDirectory(claudeRoot: string, workspacePath: string): string {
  const normalized = normalize(resolve(workspacePath));
  const encoded = normalized.replaceAll(/[^\p{L}\p{N}._-]/gu, "-");
  return join(claudeRoot, "projects", encoded);
}

export function sessionKey(input: {
  vaultId: string;
  profileId: string;
  workspaceId: string;
  nativeSessionId: string;
}): string {
  for (const value of Object.values(input)) {
    if (value.length === 0 || value.includes(":")) throw new TypeError("session identity components must be non-empty and colon-free");
  }
  return `${input.vaultId}:claude:${input.profileId}:${input.workspaceId}:${input.nativeSessionId}`;
}

export function classifyClaudePath(relativePath: string): ClaudePathClass {
  const path = safeRelative(relativePath);
  if (/^(?:credentials|auth)(?:\.json|\/)/u.test(path)) return "credential-excluded";
  if (path.startsWith("projects/") && path.endsWith(".jsonl")) return "session";
  if (path.startsWith("skills/")) return "skill";
  if (path === "settings.json" || path === "CLAUDE.md" || path.startsWith("memory/")) return "config-filtered";
  if (path.startsWith("debug/") || path.startsWith("cache/") || path.startsWith("tmp/")) return "cache-excluded";
  return "unknown-excluded";
}

function safeRelative(input: string): string {
  if (input.length === 0 || input.includes("\0") || input.includes("\\") || isAbsolute(input)) {
    throw new TypeError("path must be a safe relative POSIX path");
  }
  const parts = input.split("/").filter((part) => part !== ".");
  if (parts.includes("..")) throw new TypeError("path must be a safe relative POSIX path");
  return parts.join("/");
}
