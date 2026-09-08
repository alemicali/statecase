// AD-MEM-008: this assertion is only for the first request of a NEW session.
// A restored assistant turn or a Read result is not evidence of startup recall.
export function assertClaudeMemoryContext(body, expected) {
  const fail = () => {
    const error = new Error("native memory context mismatch");
    error.code = "NATIVE_MEMORY_MISMATCH";
    throw error;
  };
  const text = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content) || content.some((block) => block?.type !== "text" || typeof block.text !== "string")) return fail();
    return content.map((block) => block.text).join("\n");
  };
  if (typeof expected.prompt !== "string" || !expected.prompt ||
      [...expected.required, ...expected.forbidden].some((marker) => typeof marker !== "string" || !marker || expected.prompt.includes(marker)) ||
      expected.required.some((marker) => expected.forbidden.includes(marker)) ||
      !Array.isArray(body?.messages) || !body.messages.length || body.messages.some((message) => message?.role !== "user")) return fail();
  const messages = body.messages.map((message) => text(message.content)).join("\n");
  const context = `${body.system === undefined ? "" : text(body.system)}\n${messages}`;
  if (!messages.includes(expected.prompt) || expected.required.some((marker) => !context.includes(marker)) ||
      expected.forbidden.some((marker) => context.includes(marker))) fail();
}
