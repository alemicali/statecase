import { isDeepStrictEqual } from "node:util";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";

// Test-only request assertions. Do not log bodies: they contain native context.
export function assertNativePreferences(kind, body, expected) {
  const effort = kind === "codex" ? body?.reasoning?.effort : kind === "claude" ? body?.output_config?.effort : undefined;
  if (!body || Array.isArray(body) || body.model !== expected.model || effort !== expected.effort || !["codex", "claude"].includes(kind)) {
    const error = new Error("native effective preferences mismatch");
    error.code = !["codex", "claude"].includes(kind) ? "NATIVE_HARNESS_UNSUPPORTED"
      : body?.model !== expected.model ? "NATIVE_MODEL_MISMATCH" : "NATIVE_EFFORT_MISMATCH";
    throw error;
  }
}

// Bounded synthetic-fixture diagnostics only. No arbitrary key, path, value or
// parser exception may escape; this does not relax the byte-preservation test.
export function summarizeNativeConfigChange(before, after) {
  try {
    if ([before, after].some((value) => typeof value !== "string" || Buffer.byteLength(value) > 1024 * 1024)) throw new Error();
    const a = getStaticTOMLValue(parseTOML(before, { tomlVersion: "1.0" }));
    const b = getStaticTOMLValue(parseTOML(after, { tomlVersion: "1.0" }));
    const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !isDeepStrictEqual(a[key], b[key]));
    const allowed = ["model", "model_reasoning_effort", "model_provider", "approval_policy", "sandbox_mode", "web_search",
      "model_providers", "notice", "projects", "permissions", "default_permissions", "features", "tui"];
    return { kind: before === after ? "unchanged" : changed.length ? "values" : "formatting",
      fields: allowed.filter((key) => changed.includes(key)), other: changed.some((key) => !allowed.includes(key)) };
  } catch { return { kind: "invalid", fields: [], other: false }; }
}

export function summarizeNativeProjectChange(before, after, paths) {
  try {
    const projects = (text) => {
      if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024) throw new Error();
      const value = getStaticTOMLValue(parseTOML(text, { tomlVersion: "1.0" })).projects ?? {};
      if (typeof value !== "object" || Array.isArray(value) || value === null) throw new Error();
      return value;
    };
    const a = projects(before), b = projects(after);
    const trust = (value) => value === undefined ? "absent" : ["trusted", "untrusted"].includes(value) ? value : "other";
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((path) => !isDeepStrictEqual(a[path], b[path])).slice(0, 8).map((path) => ({
      scope: path === paths.target ? "target" : path === paths.source ? "source" : "other",
      kind: a[path] === undefined ? "added" : b[path] === undefined ? "removed" : "modified",
      trustBefore: trust(a[path]?.trust_level), trustAfter: trust(b[path]?.trust_level),
      other: [...new Set([...Object.keys(a[path] ?? {}), ...Object.keys(b[path] ?? {})])]
        .some((key) => key !== "trust_level" && !isDeepStrictEqual(a[path]?.[key], b[path]?.[key])),
    }));
  } catch { return [{ scope: "invalid" }]; }
}
