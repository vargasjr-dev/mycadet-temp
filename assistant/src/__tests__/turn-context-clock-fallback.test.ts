/**
 * Tests for the `<turn_context>` clock fallback.
 *
 * `applyRuntimeInjections` must never emit a turn without a
 * `<turn_context>` block. The rehydrated history carries every prior turn's
 * block with its ORIGINAL stamp, so a silent skip (the old behavior when the
 * conversation had no frozen `currentTurnTemporalSnapshot`) leaves the model
 * grounded on the stalest `current_time:` line still in context — observed
 * live as a Tuesday stamp grounding a Thursday reply. The assembly now falls
 * back to the host clock when the snapshot is missing.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { Message } from "../providers/types.js";
import { asConversation } from "./helpers/mock-conversation.js";

// NOTE: no config overrides and no module mocks needed here — memory v2 is
// enabled by default (which already silences the v1 PKB injector), and
// `formatTurnTimestamp` is deliberately NOT mocked: the fallback's whole
// point is that the stamp reflects the real wall clock.

const { applyRuntimeInjections } =
  await import("../daemon/conversation-runtime-assembly.js");
const { formatTurnTimestamp } = await import("../daemon/date-context.js");
const { clearConversations, setConversation } =
  await import("../daemon/conversation-registry.js");
const { initializeDb } = await import("../persistence/db-init.js");
const { registerDefaultPluginInjectors } =
  await import("../plugins/defaults/index.js");

await initializeDb();
registerDefaultPluginInjectors();

const NO_SNAPSHOT_CONVERSATION_ID = "conv-turn-context-no-snapshot";

function seedConversationWithoutSnapshot(): void {
  setConversation(
    NO_SNAPSHOT_CONVERSATION_ID,
    asConversation({
      conversationId: NO_SNAPSHOT_CONVERSATION_ID,
      workingDir: "/sandbox",
      workspaceTopLevelContext: "",
      workspaceTopLevelDirty: false,
      // No `currentTurnTemporalSnapshot` — the loop never froze one for this
      // conversation (the evicted-and-reloaded / test-fake shape).
    }),
  );
}

function userTurn(text: string): Message[] {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

describe("turn-context clock fallback", () => {
  beforeEach(() => {
    clearConversations();
  });

  test("emits a <turn_context> block for a conversation with no frozen snapshot", async () => {
    seedConversationWithoutSnapshot();
    const result = await applyRuntimeInjections(userTurn("hello"), {
      conversationId: NO_SNAPSHOT_CONVERSATION_ID,
    });

    // The old behavior returned `undefined` here — the silent skip this
    // suite exists to prevent.
    const block = result.blocks.unifiedTurnContext;
    expect(block).toBeDefined();
    expect(block).toContain("<turn_context>");
    expect(block).toContain("current_time: ");
  });

  test("the fallback stamp reflects the real wall clock, not a historical block", async () => {
    seedConversationWithoutSnapshot();
    const result = await applyRuntimeInjections(userTurn("hello"), {
      conversationId: NO_SNAPSHOT_CONVERSATION_ID,
    });

    const block = result.blocks.unifiedTurnContext!;
    const match = block.match(/current_time: ([^\n]+)/);
    expect(match).not.toBeNull();

    // Same calendar day as the host clock, rendered by the same formatter —
    // robust to second-level drift between assembly and this assertion.
    const stampDate = match![1].slice(0, 10);
    expect(stampDate).toBe(formatTurnTimestamp({}).slice(0, 10));
  });

  test("a frozen snapshot still wins: client timezone flows through unchanged", async () => {
    setConversation(
      "conv-turn-context-with-snapshot",
      asConversation({
        conversationId: "conv-turn-context-with-snapshot",
        workingDir: "/sandbox",
        workspaceTopLevelContext: "",
        workspaceTopLevelDirty: false,
        currentTurnTemporalSnapshot: {
          clientTimezone: "America/New_York",
          timeSinceLastMessage: null,
        },
      }),
    );
    const result = await applyRuntimeInjections(userTurn("hello"), {
      conversationId: "conv-turn-context-with-snapshot",
    });

    const block = result.blocks.unifiedTurnContext!;
    expect(block).toContain("<turn_context>");
    // The snapshot's client timezone steers the stamp's zone.
    expect(block).toContain("(America/New_York)");
  });
});
