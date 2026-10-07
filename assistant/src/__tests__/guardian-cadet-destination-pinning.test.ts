/**
 * Regression tests for guardian-card cadet destination routing (LUM-2870).
 *
 * Two unrelated guardian requests must never share a cadet conversation:
 * un-pinned requests are forced to `start_new` by the decision engine's
 * guardian-request affinity guard (overriding any LLM `reuse_existing`
 * choice), so each request pairs with its own fresh conversation; pinned
 * requests land in their originating conversation via the affinity hint.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

// ── Mocks — declared before imports that depend on them ─────────────
import { pairDeliveryWithConversation } from "../notifications/conversation-pairing.js";
import { enforceGuardianRequestConversationAffinity } from "../notifications/decision-engine.js";
import type { NotificationSignal } from "../notifications/signal.js";
import {
  ensureConversationExists,
  getMessages,
} from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";
beforeAll(async () => {
  await initializeDb();
});

import type {
  ConversationAction,
  NotificationDecision,
} from "../notifications/types.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: `sig-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    sourceChannel: "slack",
    sourceContextId: "ctx-1",
    sourceEventName: "guardian.question",
    contextPayload: {},
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    requiresConversation: true,
    ...overrides,
  };
}

function makeLlmDecisionReusing(conversationId: string): NotificationDecision {
  return {
    shouldNotify: true,
    selectedChannels: ["cadet"],
    reasoningSummary: "llm chose reuse",
    renderedCopy: {
      cadet: { title: "Approval needed", body: "Please decide." },
    },
    conversationActions: {
      cadet: { action: "reuse_existing", conversationId },
    },
    dedupeKey: "test-key",
    confidence: 0.9,
    fallbackUsed: false,
  };
}

/** Run a signal's decision through the guard and pair the cadet delivery. */
async function routeCadetDelivery(
  signal: NotificationSignal,
  decision: NotificationDecision,
) {
  const guarded = enforceGuardianRequestConversationAffinity(decision, signal);
  const conversationAction = guarded.conversationActions?.cadet as
    | ConversationAction
    | undefined;
  return pairDeliveryWithConversation(
    signal,
    "cadet",
    guarded.renderedCopy.cadet!,
    { conversationAction },
  );
}

// ── Tests ───────────────────────────────────────────────────────────

describe("guardian cadet destination pinning", () => {
  beforeEach(() => {
    // Seed the two conversations the LLM decisions reference, for real.
    ensureConversationExists("conv-catchall", "cadet");
    ensureConversationExists("conv-origin", "cadet");
  });

  test("two unrelated un-pinned guardian requests land in two different conversations", async () => {
    // Both decisions simulate the LLM steering to the same catch-all.
    const accessRequest = makeSignal({
      sourceEventName: "ingress.access_request",
      contextPayload: { requestId: "access-req-1" },
    });
    const toolGrant = makeSignal({
      sourceEventName: "guardian.question",
      contextPayload: {
        requestId: "tool-grant-1",
        requestKind: "tool_grant_request",
        toolName: "host_bash",
      },
    });

    const first = await routeCadetDelivery(
      accessRequest,
      makeLlmDecisionReusing("conv-catchall"),
    );
    const second = await routeCadetDelivery(
      toolGrant,
      makeLlmDecisionReusing("conv-catchall"),
    );

    expect(first.conversationId).toBeTruthy();
    expect(second.conversationId).toBeTruthy();
    expect(first.conversationId).not.toBe(second.conversationId);
    expect(first.createdNewConversation).toBe(true);
    expect(second.createdNewConversation).toBe(true);
    // The catch-all never receives either card.
    expect(getMessages("conv-catchall")).toHaveLength(0);
  });

  test("a pinned guardian request lands in its originating conversation", async () => {
    const pinned = makeSignal({
      sourceEventName: "guardian.question",
      contextPayload: {
        requestId: "tool-approval-1",
        requestKind: "tool_approval",
        toolName: "bash",
      },
      conversationAffinityHint: { cadet: "conv-origin" },
      conversationMetadata: { source: "user" },
    });

    // With a hint the guard is a no-op; affinity enforcement (exercised in
    // decision-engine tests) rewrites the action to reuse the pinned target.
    const guarded = enforceGuardianRequestConversationAffinity(
      makeLlmDecisionReusing("conv-catchall"),
      pinned,
    );
    expect(guarded.conversationActions?.cadet).toEqual({
      action: "reuse_existing",
      conversationId: "conv-catchall",
    });

    const pairing = await pairDeliveryWithConversation(
      pinned,
      "cadet",
      guarded.renderedCopy.cadet!,
      {
        conversationAction: {
          action: "reuse_existing",
          conversationId: "conv-origin",
        },
      },
    );

    expect(pairing.conversationId).toBe("conv-origin");
    expect(pairing.createdNewConversation).toBe(false);
    expect(getMessages("conv-origin")).toHaveLength(1);
  });
});
