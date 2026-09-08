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
