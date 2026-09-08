import { describe, expect, it } from "vitest";
import { nativeResponseEvents } from "../scripts/uat/native-responses-events.mjs";

describe("native Responses text fixture protocol (AD-CFG-012)", () => {
  it("streams text through content/delta/done events before completing the response", () => {
    const content = { type: "output_text", text: "fixture completion", annotations: [] };
    const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [content] };
    const completed = { id: "resp_fixture", status: "completed", output: [item] };
    const events = nativeResponseEvents(completed);
    expect(events.map((event) => event.type)).toEqual(["response.created", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"]);
    expect(events[1].item).toMatchObject({ status: "in_progress", content: [] });
    expect(events[3]).toMatchObject({ item_id: item.id, content_index: 0, output_index: 0, delta: content.text });
    expect(events[5].part).toEqual(content); expect(events.at(-1).response).toEqual(completed);
    expect(completed.output[0]).toEqual(item);
  });
  it.each(["function_call", "custom_tool_call"])("retains the qualified native %s fixture path", (type) => {
    const item = { id: "tool_fixture", type, call_id: "call_fixture", name: "fixture", arguments: "{}" };
    const events = nativeResponseEvents({ id: "resp_fixture", output: [item] });
    expect(events.map((event) => event.type)).toEqual(["response.created", "response.output_item.added", "response.output_item.done", "response.completed"]);
    expect(events[1].item).toEqual(item);
  });
});
