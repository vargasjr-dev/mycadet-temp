/**
 * Tests for persisting an answered `ask_question` prompt onto its tool_use
 * block, so the question and the user's answer stay in the transcript instead
 * of disappearing with the interactive card.
 *
 * Covers the write half of the round-trip:
 *   handleToolResult(event carrying answeredQuestion)
 *     → immediate `_answeredQuestion` stamp on the persisted row
 *     → state.toolAnsweredQuestions captures it
 *     → annotatePersistedAssistantMessage re-stamps at end of turn
 *
 * The read half (renderHistoryContent in handlers/shared.ts) lives in
 * server-history-render.test.ts.
 */
import { beforeAll, describe, expect, test } from "bun:test";

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import type { AnsweredQuestion } from "../api/events/question-answered.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  handleToolResult,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  addMessage,
  ensureConversationExists,
  getMessageById,
} from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";
import type { ContentBlock } from "../providers/types.js";
import { mockUnownedModeSessions } from "./helpers/mock-conversation.js";
beforeAll(async () => {
  await initializeDb();
});

let convSeq = 0;
let currentRowId = "";

// ── Helpers ───────────────────────────────────────────────────────────────────

const emitted: Array<Record<string, unknown>> = [];

function makeDeps(): EventHandlerDeps {
  return {
    ctx: {
      conversationId: "test-conv",
      provider: { name: "anthropic" },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
      modeSessions: mockUnownedModeSessions(),
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (event: unknown) => {
      emitted.push(event as Record<string, unknown>);
    },
    reqId: "test-req",
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }) as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: "cadet",
      assistantMessageChannel: "cadet",
    } as unknown as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "web",
      assistantMessageInterface: "web",
    } as unknown as EventHandlerDeps["turnInterfaceContext"],
    applyCompaction: async () => {},
  };
}

/**
 * Seed a turn whose assistant row holds `toolUseIds` tool_use blocks, all of
 * them `ask_question` unless stated otherwise. Every id is registered as
 * in-flight, so end-of-turn annotation only runs once each has a result.
 */
async function setupState(toolUseIds: string[]): Promise<EventHandlerState> {
  const state = createEventHandlerState();
  for (const id of toolUseIds) {
    state.toolUseIdToName.set(id, "ask_question");
    state.toolCallTimestamps.set(id, { startedAt: Date.now() });
    state.currentTurnToolUseIds.push(id);
  }
  const conversationId = `conv-answered-${++convSeq}`;
  ensureConversationExists(conversationId, undefined);
  const row = await addMessage(
    conversationId,
    "assistant",
    JSON.stringify(
      toolUseIds.map((id) => ({
        type: "tool_use",
        id,
        name: "ask_question",
        input: { questions: [{ question: "Which Alice?", options: [] }] },
      })),
    ),
  );
  currentRowId = row.id;
  state.lastAssistantMessageId = row.id;
  return state;
}

function persistedToolUse(toolUseId: string): Record<string, unknown> {
  const row = getMessageById(currentRowId);
  if (!row) {
    throw new Error(`row ${currentRowId} not found`);
  }
  const block = (row.content as unknown as ContentBlock[]).find(
    (b) =>
      b.type === "tool_use" &&
      (b as unknown as Record<string, unknown>).id === toolUseId,
  ) as unknown as Record<string, unknown> | undefined;
  if (!block) {
    throw new Error(`tool_use block ${toolUseId} not found`);
  }
  return block;
}

const ANSWERED: AnsweredQuestion = {
  requestId: "req-1",
  questions: [
    {
      id: "q1",
      question: "Which Alice?",
      options: [
        { id: "alice_work", label: "Alice (work)" },
        { id: "alice_personal", label: "Alice (personal)" },
      ],
    },
  ],
  responses: [{ questionId: "q1", decision: "option", optionId: "alice_work" }],
  overall: "completed",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("answered ask_question persistence", () => {
  test("stamps the answered record on the tool_use block and forwards it to clients", async () => {
    const state = await setupState(["tu_q"]);

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId: "tu_q",
      content: 'Question "Which Alice?" → Option: alice_work (Alice (work))',
      isError: false,
      answeredQuestion: ANSWERED,
    });

    expect(persistedToolUse("tu_q")._answeredQuestion).toEqual(ANSWERED);
    const toolResult = emitted.find((e) => e.type === "tool_result");
    expect(toolResult?.answeredQuestion).toEqual(ANSWERED);
  });

  test("stamps immediately, before the turn's other tools have finished", async () => {
    // A batch where `ask_question` settles first: the user can switch away
    // (forcing a history refetch) while the sibling tool still runs, so the
    // answer must already be durable rather than waiting for end-of-turn
    // annotation.
    const state = await setupState(["tu_q", "tu_slow"]);

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId: "tu_q",
      content: "answered",
      isError: false,
      answeredQuestion: ANSWERED,
    });

    expect(
      state.toolCallTimestamps.get("tu_slow")?.completedAt,
    ).toBeUndefined();
    expect(persistedToolUse("tu_q")._answeredQuestion).toEqual(ANSWERED);
  });

  test("survives the end-of-turn annotation that re-stamps the row", async () => {
    const state = await setupState(["tu_q"]);
    const deps = makeDeps();

    handleToolResult(state, deps, {
      type: "tool_result",
      toolUseId: "tu_q",
      content: "answered",
      isError: false,
      answeredQuestion: ANSWERED,
    });

    // The result above completes the turn's only tool, so annotation has
    // already run. It writes timing metadata alongside, and must not drop the
    // answered record it did not author.
    const block = persistedToolUse("tu_q");
    expect(block._answeredQuestion).toEqual(ANSWERED);
    expect(block._startedAt).toBeNumber();
  });

  test("re-stamping the same record does not rewrite the row", async () => {
    const state = await setupState(["tu_q"]);
    const deps = makeDeps();

    handleToolResult(state, deps, {
      type: "tool_result",
      toolUseId: "tu_q",
      content: "answered",
      isError: false,
      answeredQuestion: ANSWERED,
    });
    // Early stamp + end-of-turn annotation.
    const contentAfterFirstStamp = JSON.stringify(
      getMessageById(currentRowId)!.content,
    );

    handleToolResult(state, deps, {
      type: "tool_result",
      toolUseId: "tu_q",
      content: "answered",
      isError: false,
      answeredQuestion: ANSWERED,
    });

    // The second result re-runs the early stamp; the identical requestId makes
    // it a no-op, so the row is not rewritten.
    expect(JSON.stringify(getMessageById(currentRowId)!.content)).toBe(
      contentAfterFirstStamp,
    );
    expect(persistedToolUse("tu_q")._answeredQuestion).toEqual(ANSWERED);
  });

  test("leaves the block unstamped when the result carries no answered record", async () => {
    const state = await setupState(["tu_q"]);

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId: "tu_q",
      content: "User did not respond within timeout",
      isError: true,
    });

    expect(persistedToolUse("tu_q")._answeredQuestion).toBeUndefined();
  });
});
