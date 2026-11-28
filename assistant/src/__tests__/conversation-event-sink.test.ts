import { describe, expect, test } from "bun:test";

import { setBroadcastOverrideForTesting } from "../runtime/assistant-event-hub.js";

const published: Array<{ type: string; conversationId: string | undefined }> =
  [];
setBroadcastOverrideForTesting(
  (msg: { type: string }, conversationId?: string) => {
    published.push({ type: msg.type, conversationId });
  },
);

const { conversationEventSink } =
  await import("../daemon/conversation-event-sink.js");

/**
 * The scoping guarantee the hub depends on: attribution comes from the
 * emitting conversation, so an event carrying no conversation of its own is
 * still filtered, seq-stamped and replayed like every other one.
 */
describe("conversationEventSink", () => {
  test("scopes an event whose payload names no conversation", () => {
    published.length = 0;

    conversationEventSink("conv-parent")({
      type: "subagent_status_changed",
      subagentId: "sa-1",
      status: "running",
    });

    expect(published).toEqual([
      { type: "subagent_status_changed", conversationId: "conv-parent" },
    ]);
  });

  test("scopes every event to the emitting conversation, not the payload's", () => {
    published.length = 0;
    const sink = conversationEventSink("conv-parent");

    sink({
      type: "subagent_spawned",
      subagentId: "sa-1",
      parentConversationId: "conv-parent",
      label: "Worker",
      objective: "Summarize the task",
    });
    sink({
      type: "subagent_event",
      subagentId: "sa-1",
      conversationId: "conv-parent",
      event: { type: "assistant_text_delta", text: "Working" },
    });

    expect(published.map((p) => p.conversationId)).toEqual([
      "conv-parent",
      "conv-parent",
    ]);
  });
});
