import { describe, expect, test } from "bun:test";

import pino from "pino";

import type { AssistantEvent } from "../api/index.js";
import {
  createEventHandlerState,
  type EventHandlerDeps,
  handleMaxTokensReached,
} from "../daemon/conversation-agent-loop-handlers.js";
import { asConversation } from "./helpers/mock-conversation.js";

describe("max tokens reached handler", () => {
  test("emits and stores an inline continuation card", () => {
    const sent: AssistantEvent[] = [];
    const ctx = asConversation({
      conversationId: "conv-1",
      surfaceState: new Map(),
      currentTurnSurfaces: [],
    });
    const deps: EventHandlerDeps = {
      ctx,
      onEvent: (msg: AssistantEvent) => sent.push(msg),
      reqId: "req-1",
      isFirstMessage: false,
      shouldGenerateTitle: false,
      rlog: pino({ enabled: false }),
      turnChannelContext: {
        userMessageChannel: "cadet",
        assistantMessageChannel: "cadet",
      },
      turnInterfaceContext: {
        userMessageInterface: "web",
        assistantMessageInterface: "web",
      },
      applyCompaction: async () => {},
    };

    handleMaxTokensReached(createEventHandlerState(), deps, {
      type: "max_tokens_reached",
      stopReason: "max_tokens",
    });

    const show = sent.find((msg) => msg.type === "ui_surface_show");
    expect(show).toBeDefined();
    if (!show || show.type !== "ui_surface_show") {
      return;
    }

    expect(show.surfaceType).toBe("card");
    expect(show.data?.title).toBe("Response limit reached");
    expect(show.actions?.[0]?.id).toBe("relay_prompt");
    expect(show.actions?.[0]?.data?.prompt).toContain("Continue");
    expect(show.actions?.[0]?.data?._completeSurface).toBe(true);
    expect(ctx.currentTurnSurfaces).toHaveLength(1);
    expect(ctx.surfaceState.has(show.surfaceId)).toBe(true);
  });
});
