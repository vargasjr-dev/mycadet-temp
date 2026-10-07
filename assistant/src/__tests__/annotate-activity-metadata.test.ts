/**
 * Tests for `annotatePersistedAssistantMessage` persisting `_activityMetadata`
 * (web_search / web_fetch) alongside the tool call.
 *
 * Without this annotation the tool activity card (e.g. WebSearchProgressCard)
 * is lost on a history reopen — the snapshot only carries the plain result
 * text. External provider tools (brave/perplexity/tavily, web_fetch) resolve
 * their activity only when the `tool_result` lands, after `message_complete`
 * already persisted the block, so they are stamped here. Native server tools
 * (Anthropic web_search) resolve before `message_complete` and are stamped at
 * persist time in `buildPersistedAssistantContent` (covered separately in
 * build-persisted-content.test.ts).
 *
 * The test exercises the populate → annotate → persist round-trip:
 *   handleToolResult(event with activityMetadata)
 *     → state.toolActivityMetadata captures it
 *     → annotatePersistedAssistantMessage writes _activityMetadata onto the row
 *     → updateMessageContent receives the JSON-serialized output
 *
 * Read-side coverage (renderHistoryContent in handlers/shared.ts) lives in
 * server-history-render.test.ts.
 */
import { beforeAll, describe, expect, test } from "bun:test";

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import type { ToolActivityMetadata } from "../api/events/tool-result.js";
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
/** Create a real conversation + assistant row carrying `blocks` as content. */
async function seedAssistantMessage(blocks: unknown): Promise<string> {
  const conversationId = `conv-annotate-${++convSeq}`;
  ensureConversationExists(conversationId, undefined);
  const row = await addMessage(
    conversationId,
    "assistant",
    JSON.stringify(blocks),
  );
  return row.id;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    onEvent: () => {},
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

function setupState(toolUseId: string): EventHandlerState {
  const state = createEventHandlerState();
  state.lastAssistantMessageId = "msg-1";
  state.toolUseIdToName.set(toolUseId, "web_search");
  state.toolCallTimestamps.set(toolUseId, { startedAt: Date.now() });
  state.currentTurnToolUseIds.push(toolUseId);
  return state;
}

function findBlockById(
  rawContent: ContentBlock[] | string,
  id: string,
): Record<string, unknown> {
  const parsed = (
    typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent
  ) as Array<Record<string, unknown>>;
  const block = parsed.find((b) => b.id === id);
  if (!block) {
    throw new Error(`block ${id} not found`);
  }
  return block;
}

const webSearchActivity: ToolActivityMetadata = {
  webSearch: {
    query: "cadet docs",
    provider: "brave",
    resultCount: 2,
    durationMs: 142,
    results: [
      {
        rank: 1,
        title: "Cadet",
        url: "https://mycadet.ai",
        domain: "mycadet.ai",
      },
      {
        rank: 2,
        title: "Docs",
        url: "https://docs.mycadet.ai",
        domain: "docs.mycadet.ai",
      },
    ],
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("annotatePersistedAssistantMessage — activityMetadata", () => {
  test("persists activityMetadata from the live tool_result event onto the tool_use block", async () => {
    // GIVEN a persisted tool_use block for an external web_search tool
    const toolUseId = "tu_web_search";
    const state = setupState(toolUseId);
    state.lastAssistantMessageId = await seedAssistantMessage([
      {
        type: "tool_use",
        id: toolUseId,
        name: "web_search",
        input: { query: "cadet docs" },
      },
    ]);

    // WHEN the tool result lands carrying activityMetadata
    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId,
      content: "results",
      isError: false,
      activityMetadata: webSearchActivity,
    });

    // THEN the metadata is stamped on the persisted block verbatim
    const row = getMessageById(state.lastAssistantMessageId!);
    const block = findBlockById(row!.content as ContentBlock[], toolUseId);
    expect(block._activityMetadata).toEqual(webSearchActivity);
  });

  test("leaves native server_tool_use blocks untouched (stamped at persist time)", async () => {
    // GIVEN an external tool completes (to trigger annotation) AND a native
    // server_tool_use block whose activity was captured at server_tool_complete
    const externalId = "tu_external";
    const nativeId = "srvtu_native_search";
    const state = setupState(externalId);
    state.toolActivityMetadata.set(nativeId, webSearchActivity);
    state.lastAssistantMessageId = await seedAssistantMessage([
      {
        type: "server_tool_use",
        id: nativeId,
        name: "web_search",
        input: { query: "cadet docs" },
      },
      {
        type: "tool_use",
        id: externalId,
        name: "bash",
        input: { command: "ls" },
      },
    ]);

    // WHEN the external tool result lands (no activity of its own)
    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId: externalId,
      content: "ok",
      isError: false,
    });

    // THEN the annotate pass does not stamp the server_tool_use block — native
    // activity is stamped earlier by `buildPersistedAssistantContent` (covered
    // in build-persisted-content.test.ts), and the unrelated external tool_use
    // block carries no activity of its own
    const row = getMessageById(state.lastAssistantMessageId!);
    const nativeBlock = findBlockById(row!.content as ContentBlock[], nativeId);
    expect(nativeBlock._activityMetadata).toBeUndefined();
    const externalBlock = findBlockById(
      row!.content as ContentBlock[],
      externalId,
    );
    expect(externalBlock._activityMetadata).toBeUndefined();
  });

  test("omits activityMetadata when the tool produced none", async () => {
    // GIVEN a non-activity tool
    const toolUseId = "tu_plain";
    const state = setupState(toolUseId);
    state.toolUseIdToName.set(toolUseId, "bash");
    state.lastAssistantMessageId = await seedAssistantMessage([
      {
        type: "tool_use",
        id: toolUseId,
        name: "bash",
        input: { command: "ls" },
      },
    ]);

    // WHEN the result lands with no activityMetadata
    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId,
      content: "ok",
      isError: false,
    });

    // THEN no _activityMetadata is written
    const row = getMessageById(state.lastAssistantMessageId!);
    const block = findBlockById(row!.content as ContentBlock[], toolUseId);
    expect(block._activityMetadata).toBeUndefined();
  });
});
