/**
 * Tests for `annotatePersistedAssistantMessage` persisting the 3 risk-option
 * arrays alongside the existing `_risk*` scalars.
 *
 * Phase B of the conflation track. Without these annotations, the Rule Editor
 * Modal's chip ladder loses its scope/allowlist/directory options on chat-
 * history reload and falls back to the synthesized `*` allowlist.
 *
 * The test exercises the full populate → annotate → persist round-trip:
 *   handleToolResult(event with 3 arrays)
 *     → state.toolRiskOutcomes captures them
 *     → annotatePersistedAssistantMessage writes _risk*Options onto the row
 *     → updateMessageContent receives the JSON-serialized output
 *
 * Read-side coverage (renderHistoryContent in handlers/shared.ts) lives in
 * server-history-render.test.ts.
 */
import { beforeAll, describe, expect, test } from "bun:test";

// ── Imports (after mocks) ─────────────────────────────────────────────────────
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
  const conversationId = `conv-risk-${++convSeq}`;
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
  state.toolUseIdToName.set(toolUseId, "bash");
  state.toolCallTimestamps.set(toolUseId, { startedAt: Date.now() });
  state.currentTurnToolUseIds.push(toolUseId);
  return state;
}

function findPersistedToolUse(
  rawContent: ContentBlock[] | string,
  toolUseId: string,
): Record<string, unknown> {
  const parsed = (
    typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent
  ) as Array<Record<string, unknown>>;
  const block = parsed.find((b) => b.type === "tool_use" && b.id === toolUseId);
  if (!block) {
    throw new Error(`tool_use block ${toolUseId} not found`);
  }
  return block;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("annotatePersistedAssistantMessage — risk-option arrays (Phase B)", () => {
  test("persists all 3 risk-option arrays from the live tool_result event", async () => {
    const toolUseId = "tu_persist_full";
    const state = setupState(toolUseId);

    state.lastAssistantMessageId = await seedAssistantMessage([
      {
        type: "tool_use",
        id: toolUseId,
        name: "bash",
        input: { command: "rm -rf /tmp" },
      },
    ]);

    const scopeOptions = [
      { pattern: "exact", label: "exact: rm -rf /tmp" },
      { pattern: "by-program", label: "All rm" },
    ];
    const allowlistOptions = [
      { label: "exact", description: "exact match", pattern: "rm -rf /tmp" },
      { label: "All rm", description: "All rm commands", pattern: "rm *" },
    ];
    const directoryScopeOptions = [
      { scope: "/Users/me/code", label: "in code/" },
      { scope: "everywhere", label: "Everywhere" },
    ];

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId,
      content: "ok",
      isError: false,
      riskLevel: "high",
      riskReason: "Modifies state",
      matchedTrustRuleId: "rule_42",
      riskScopeOptions: scopeOptions,
      riskAllowlistOptions: allowlistOptions,
      riskDirectoryScopeOptions: directoryScopeOptions,
      approvalMode: "prompted",
      approvalReason: "user_approved",
      riskThreshold: "relaxed",
    });

    const row = getMessageById(state.lastAssistantMessageId!);
    const block = findPersistedToolUse(
      row!.content as ContentBlock[],
      toolUseId,
    );
    // Existing scalars still flow through.
    expect(block._riskLevel).toBe("high");
    expect(block._riskReason).toBe("Modifies state");
    expect(block._matchedTrustRuleId).toBe("rule_42");
    expect(block._approvalMode).toBe("prompted");
    expect(block._approvalReason).toBe("user_approved");
    expect(block._riskThreshold).toBe("relaxed");
    // New: 3 risk-option arrays persisted verbatim.
    expect(block._riskScopeOptions).toEqual(scopeOptions);
    expect(block._riskAllowlistOptions).toEqual(allowlistOptions);
    expect(block._riskDirectoryScopeOptions).toEqual(directoryScopeOptions);
  });

  test("omits empty arrays from the persisted block (saves DB space)", async () => {
    const toolUseId = "tu_persist_empty";
    const state = setupState(toolUseId);

    state.lastAssistantMessageId = await seedAssistantMessage([
      {
        type: "tool_use",
        id: toolUseId,
        name: "bash",
        input: { command: "ls" },
      },
    ]);

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId,
      content: "ok",
      isError: false,
      riskLevel: "low",
      riskScopeOptions: [],
      riskAllowlistOptions: [],
      riskDirectoryScopeOptions: [],
    });

    const row = getMessageById(state.lastAssistantMessageId!);
    const block = findPersistedToolUse(
      row!.content as ContentBlock[],
      toolUseId,
    );
    expect(block._riskLevel).toBe("low");
    expect(block._riskScopeOptions).toBeUndefined();
    expect(block._riskAllowlistOptions).toBeUndefined();
    expect(block._riskDirectoryScopeOptions).toBeUndefined();
  });

  test("omits absent (undefined) arrays from the persisted block", async () => {
    // Mirrors classic bash/file tools that don't always emit all 3 arrays —
    // e.g. recall, file_read with riskLevel=low and no allowlist coverage.
    const toolUseId = "tu_persist_absent";
    const state = setupState(toolUseId);

    state.lastAssistantMessageId = await seedAssistantMessage([
      {
        type: "tool_use",
        id: toolUseId,
        name: "recall",
        input: { query: "anything" },
      },
    ]);

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId,
      content: "ok",
      isError: false,
      riskLevel: "low",
      // No risk-option arrays passed at all.
    });

    const row = getMessageById(state.lastAssistantMessageId!);
    const block = findPersistedToolUse(
      row!.content as ContentBlock[],
      toolUseId,
    );
    expect(block._riskLevel).toBe("low");
    expect(block._riskScopeOptions).toBeUndefined();
    expect(block._riskAllowlistOptions).toBeUndefined();
    expect(block._riskDirectoryScopeOptions).toBeUndefined();
  });

  test("partial coverage — only allowlist options present (e.g. tools with classifier but no scope ladder)", async () => {
    const toolUseId = "tu_partial";
    const state = setupState(toolUseId);

    state.lastAssistantMessageId = await seedAssistantMessage([
      {
        type: "tool_use",
        id: toolUseId,
        name: "file_write",
        input: { path: "/tmp/foo.txt" },
      },
    ]);

    const allowlistOptions = [
      { label: "exact", description: "exact match", pattern: "/tmp/foo.txt" },
    ];

    handleToolResult(state, makeDeps(), {
      type: "tool_result",
      toolUseId,
      content: "ok",
      isError: false,
      riskLevel: "medium",
      riskAllowlistOptions: allowlistOptions,
    });

    const row = getMessageById(state.lastAssistantMessageId!);
    const block = findPersistedToolUse(
      row!.content as ContentBlock[],
      toolUseId,
    );
    expect(block._riskLevel).toBe("medium");
    expect(block._riskAllowlistOptions).toEqual(allowlistOptions);
    expect(block._riskScopeOptions).toBeUndefined();
    expect(block._riskDirectoryScopeOptions).toBeUndefined();
  });
});
