import { isAbsolute, join, normalize, resolve, sep } from "node:path";

export interface CodexRootOptions {
  home: string;
  cwd?: string;
  env: Readonly<Record<string, string | undefined>>;
  configText?: string;
}

export interface CodexRoots {
  codexHome: string;
  sqliteHome: string;
}

export type CodexPathClass =
  | "session"
  | "skill"
  | "config-filtered"
  | "credential-excluded"
  | "live-db-excluded"
  | "cache-excluded"
  | "binary-excluded"
  | "unknown-excluded";

export function resolveCodexRoots(options: CodexRootOptions): CodexRoots {
  const cwd = options.cwd ?? process.cwd();
  const codexHome = absoluteFrom(options.env.CODEX_HOME ?? join(options.home, ".codex"), cwd);
  const configuredSqlite = options.configText ? readStringSetting(options.configText, "sqlite_home") : undefined;
  const sqliteValue = configuredSqlite ?? options.env.CODEX_SQLITE_HOME ?? codexHome;
  return { codexHome, sqliteHome: absoluteFrom(sqliteValue, cwd) };
}

export function classifyCodexPath(relativePath: string): CodexPathClass {
  const path = safeRelative(relativePath);
  if (path === "auth.json" || path.startsWith("credentials/")) return "credential-excluded";
  if (/^(?:state(?:_[\w-]+)?\.db)(?:-(?:wal|shm))?$/u.test(path)) return "live-db-excluded";
  if (path.startsWith("sessions/") && path.endsWith(".jsonl")) return "session";
  if (path.startsWith("skills/")) return "skill";
  if (path === "config.toml") return "config-filtered";
  if (path.startsWith("logs/") || path.startsWith("cache/") || path.startsWith("tmp/")) return "cache-excluded";
  if (path.startsWith("bin/")) return "binary-excluded";
  return "unknown-excluded";
}

function readStringSetting(configText: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\s*${escaped}\\s*=\\s*(["'])(.*?)\\1\\s*(?:#.*)?$`, "mu").exec(configText);
  return match?.[2];
}

function absoluteFrom(path: string, cwd: string): string {
  return normalize(isAbsolute(path) ? path : resolve(cwd, path));
}

function safeRelative(input: string): string {
  if (input.includes("\0") || isAbsolute(input) || input.includes("\\")) throw new TypeError("path must be a safe relative POSIX path");
  const normalized = input.split("/").filter((part) => part !== ".").join("/");
  if (normalized.length === 0 || normalized.split("/").includes("..") || normalized.startsWith(sep)) {
    throw new TypeError("path must be a safe relative POSIX path");
  }
  return normalized;
}
