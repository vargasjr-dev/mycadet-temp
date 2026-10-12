/**
 * The deprecated `/x/*` route context is a compatibility shim: each field
 * delegates to a `@mycadet/plugin-api` call. These tests mock the two
 * collaborators (`publishEvent`, `runConversationTurn`) and assert the
 * delegation.
 */

import { describe, expect, mock, test } from "bun:test";

const publishCalls: Array<{ event: unknown; options: unknown }> = [];
const turnCalls: Array<{ conversationId?: string; content: unknown }> = [];

mock.module("../../../plugin-api/publish-event.js", () => ({
  publishEvent: (event: unknown, options?: unknown) => {
    publishCalls.push({ event, options });
  },
}));
mock.module("../../../plugin-api/conversation-turn.js", () => ({
  runConversationTurn: async (input: {
    conversationId?: string;
    content: unknown;
  }) => {
    turnCalls.push({
      conversationId: input.conversationId,
      content: input.content,
    });
    return { userMessageId: "user-msg-1" };
  },
}));

const { buildDeprecatedRouteContext } =
  await import("../deprecated-route-context.js");

describe("deprecated route context shim", () => {
  test("assistantEventHub.publish forwards to publishEvent", async () => {
    const ctx = buildDeprecatedRouteContext();
    const event = { id: "e1" } as never;
    const options = { excludeClientId: "tab-1" } as never;

    await ctx.assistantEventHub.publish(event, options);

    expect(publishCalls).toEqual([{ event, options }]);
  });

  test("conversations.postMessage runs a turn and returns its user message id", async () => {
    const ctx = buildDeprecatedRouteContext();

    const result = await ctx.conversations.postMessage("conv-1", "hello there");

    expect(result).toEqual({ messageId: "user-msg-1" });
    expect(turnCalls).toEqual([
      {
        conversationId: "conv-1",
        content: [{ type: "text", text: "hello there" }],
      },
    ]);
  });

  test("the context and its members are frozen", () => {
    const ctx = buildDeprecatedRouteContext();
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.assistantEventHub)).toBe(true);
    expect(Object.isFrozen(ctx.conversations)).toBe(true);
  });
});
