// Test-only SSE fixture; text must arrive through deltas, not only final items.
export function nativeResponseEvents(completed) {
  const item = completed.output[0];
  const text = item.type === "message" ? item.content[0] : undefined;
  const at = { output_index: 0, item_id: item.id, content_index: 0 };
  return [
    { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: text ? { ...item, status: "in_progress", content: [] } : item },
    ...(text ? [
      { type: "response.content_part.added", ...at, part: { ...text, text: "" } },
      { type: "response.output_text.delta", ...at, delta: text.text, logprobs: [] },
      { type: "response.output_text.done", ...at, text: text.text, logprobs: [] },
      { type: "response.content_part.done", ...at, part: text },
    ] : []),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ];
}
