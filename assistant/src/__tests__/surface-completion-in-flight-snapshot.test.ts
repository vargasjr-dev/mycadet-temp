/**
 * A one-shot surface shown with `await_action: false` can be answered before
 * the turn that created it finishes. At that moment the surface exists only in
 * `ctx.currentTurnSurfaces`: there is no persisted `ui_surface` block for
 * `markSurfaceCompleted` to patch, and both turn-finalization appenders build
 * the block fresh from that snapshot. Unless the completion rides the snapshot,
 * the appended block lands pending and the next history reseed reactivates an
 * already-answered card.
 *
 * Both appenders are covered because either one alone leaves the card live:
 *   - `buildPersistedAssistantContent` (message_complete, no tools in the turn)
 *   - `annotatePersistedAssistantMessage` (end of tool execution)
 *
 * The genuinely-ephemeral case is asserted alongside: a standalone surface owns
 * neither a persisted block nor a snapshot, and must still complete.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../api/index.js";

let broadcasts: AssistantEvent[] = [];
setBroadcastOverrideForTesting((msg: AssistantEvent) => {
  broadcasts.push(msg);
});

// Imports must follow the mocks so both modules bind the stubs above.
const { createSurfaceMutex, handleSurfaceAction, markSurfaceCompleted } =
  await import("../daemon/conversation-surfaces.js");
const {
  buildPersistedAssistantContent,
  createEventHandlerState,
  handleToolResult,
} = await import("../daemon/conversation-agent-loop-handlers.js");

import { SurfaceType } from "../api/surfaces.js";
import type { Conversation } from "../daemon/conversation.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { CurrentTurnSurface } from "../daemon/conversation-surface-state.js";
import type { SurfaceStateEntry } from "../daemon/conversation-surface-state.js";
import {
  ensureConversationExists,
  getMessageById,
  reserveMessage,
} from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";
import { setBroadcastOverrideForTesting } from "../runtime/assistant-event-hub.js";
import { mockUnownedModeSessions } from "./helpers/mock-conversation.js";
beforeAll(async () => {
  await initializeDb();
});

let CONVERSATION_ID = "conv-in-flight-surface-1";
let SURFACE_ID = "surface-in-flight-1";
let idSeq = 0;
beforeEach(() => {
  // Fresh ids per test: the real rows these flows persist must not bleed
  // into the next test's `findPersistedSurfaceBlock` scan.
  idSeq += 1;
  CONVERSATION_ID = `conv-in-flight-surface-${idSeq}`;
  SURFACE_ID = `surface-in-flight-${idSeq}`;
  broadcasts = [];
});
const CHOICE_DATA = {
  options: [
    { id: "inbox", title: "Clean up my inbox" },
    { id: "calendar", title: "Plan my week" },
  ],
};
const CHOICE_PAYLOAD = {
  choiceId: "inbox",
  choiceTitle: "Clean up my inbox",
  selectedIds: ["inbox"],
  selectedTitles: ["Clean up my inbox"],
};
const EXPECTED_SUMMARY = 'User chose: "Clean up my inbox"';

function makeContext(): Conversation {
  return {
    conversationId: CONVERSATION_ID,
    trustContext: { trustClass: "guardian", sourceChannel: "cadet" },
    sendToClient: () => {},
    emit: () => {},
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map(),
    surfaceState: new Map(),
    surfaceUndoStacks: new Map<string, string[]>(),
    accumulatedSurfaceState: new Map<string, Record<string, unknown>>(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    modeSessions: mockUnownedModeSessions(),
    pendingStandaloneSurfaces: new Map(),
    recentlyCompletedStandaloneSurfaces: new Map(),
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: true, requestId: "req-1" }),
    getQueueDepth: () => 0,
    processMessage: async () => "msg-1",
    withSurface: createSurfaceMutex(),
  } as unknown as Conversation;
}

/**
 * What `ui_show` leaves behind for a one-shot `choice` shown with
 * `await_action: false`: live state and a turn snapshot, but no
 * `pendingSurfaceActions` entry and nothing persisted yet.
 */
function showOneShotChoice(ctx: Conversation): void {
  ctx.surfaceState.set(SURFACE_ID, {
    surfaceType: "choice",
    title: "Pick one",
    data: CHOICE_DATA,
  } as unknown as SurfaceStateEntry);
  ctx.currentTurnSurfaces.push({
    surfaceId: SURFACE_ID,
    surfaceType: "choice",
    title: "Pick one",
    data: CHOICE_DATA,
    display: "inline",
  } as CurrentTurnSurface);
}

function makeHandlerDeps(ctx: Conversation): EventHandlerDeps {
  return {
    ctx: {
      ...ctx,
      provider: { name: "anthropic" },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: () => {},
    reqId: "req-in-flight",
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
  } as EventHandlerDeps;
}

/** Create the real reserved assistant row the tool-result appender rewrites. */
async function seedReservedRow(): Promise<string> {
  ensureConversationExists(CONVERSATION_ID, undefined);
  const row = await reserveMessage(CONVERSATION_ID, "assistant");
  return row.id;
}

/** Prime a finished tool call so the tool-result appender runs. */
function makeToolState(toolUseId: string, rowId: string): EventHandlerState {
  const state = createEventHandlerState();
  state.lastAssistantMessageId = rowId;
  state.toolUseIdToName.set(toolUseId, "ui_show");
  state.toolCallTimestamps.set(toolUseId, { startedAt: 1 });
  state.currentTurnToolUseIds.push(toolUseId);
  return state;
}

function surfaceBlockFrom(
  blocks: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  return blocks.find(
    (b) => b.type === "ui_surface" && b.surfaceId === SURFACE_ID,
  );
}

describe("a one-shot surface answered before its turn persists", () => {
  test("carries its completion through the message_complete appender", async () => {
    const ctx = makeContext();
    showOneShotChoice(ctx);

    await handleSurfaceAction(ctx, SURFACE_ID, "inbox", CHOICE_PAYLOAD);

    expect(
      broadcasts.filter((m) => m.type === "ui_surface_complete"),
    ).toHaveLength(1);

    const built = buildPersistedAssistantContent(
      [{ type: "text", text: "Which one?" }] as never,
      ctx.currentTurnSurfaces,
    ) as unknown as Array<Record<string, unknown>>;

    const block = surfaceBlockFrom(built);
    expect(block?.completed).toBe(true);
    expect(block?.completionSummary).toBe(EXPECTED_SUMMARY);
  });

  test("carries its completion through the tool-result appender", async () => {
    const ctx = makeContext();
    showOneShotChoice(ctx);
    const rowId = await seedReservedRow();

    await handleSurfaceAction(ctx, SURFACE_ID, "inbox", CHOICE_PAYLOAD);

    const toolUseId = "toolu_ui_show_1";
    handleToolResult(makeToolState(toolUseId, rowId), makeHandlerDeps(ctx), {
      type: "tool_result",
      toolUseId,
      content: "Surface displayed",
      isError: false,
    });

    const row = getMessageById(rowId);
    const block = surfaceBlockFrom(row!.content as never);
    expect(block?.completed).toBe(true);
    expect(block?.completionSummary).toBe(EXPECTED_SUMMARY);
  });

  test("survives a ui_update that respreads the snapshot before the turn ends", async () => {
    const ctx = makeContext();
    showOneShotChoice(ctx);

    await handleSurfaceAction(ctx, SURFACE_ID, "inbox", CHOICE_PAYLOAD);

    // The `ui_update` merge path replaces the entry with a spread copy.
    ctx.currentTurnSurfaces[0] = {
      ...ctx.currentTurnSurfaces[0],
      data: { ...CHOICE_DATA, title: "Pick one (updated)" },
    } as CurrentTurnSurface;

    const built = buildPersistedAssistantContent(
      [],
      ctx.currentTurnSurfaces,
    ) as unknown as Array<Record<string, unknown>>;

    expect(surfaceBlockFrom(built)?.completed).toBe(true);
  });
});

describe("a surface with neither a persisted block nor a turn snapshot", () => {
  test("still reports the completion as safe to announce", () => {
    const ctx = makeContext();

    expect(markSurfaceCompleted(ctx, "surface-ephemeral-1", "Done")).toBe(true);
    expect(ctx.currentTurnSurfaces).toHaveLength(0);
  });

  test("completes a standalone surface and broadcasts it", async () => {
    const ctx = makeContext();
    let resolved: unknown;
    ctx.pendingStandaloneSurfaces!.set(SURFACE_ID, {
      resolve: (result: unknown) => {
        resolved = result;
      },
      timer: setTimeout(() => {}, 0),
      surfaceType: "choice",
    } as never);
    ctx.surfaceState.set(SURFACE_ID, {
      surfaceType: "choice",
      data: CHOICE_DATA,
    } as unknown as SurfaceStateEntry);

    await handleSurfaceAction(ctx, SURFACE_ID, "inbox", CHOICE_PAYLOAD);

    expect(resolved).toBeDefined();
    expect(
      broadcasts.filter((m) => m.type === "ui_surface_complete"),
    ).toHaveLength(1);
    // Nothing to stamp: a standalone surface never enters the turn snapshot.
    expect(ctx.currentTurnSurfaces).toHaveLength(0);
  });
});
