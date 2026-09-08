// Inspect only actual native context fields; tools/metadata cannot satisfy the
// assertion. Markers are generated independently of every user prompt.
export function assertNativeInstructions(kind, body, expected) {
  const context = JSON.stringify(kind === "codex" ? [body?.instructions, body?.input]
    : kind === "claude" ? [body?.system, body?.messages] : null);
  if (!["codex", "claude"].includes(kind) || expected.required.some((marker) => !context.includes(marker)) || expected.forbidden.some((marker) => context.includes(marker))) {
    const error = new Error("native instruction context mismatch");
    error.code = "NATIVE_INSTRUCTIONS_MISMATCH";
    throw error;
  }
}
