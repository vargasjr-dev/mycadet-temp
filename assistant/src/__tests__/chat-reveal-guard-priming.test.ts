/**
 * Regression tests for the live reveal-guard priming barrier (LUM-2768).
 *
 * The race: promoting a proven `credentials reveal` starts priming
 * `liveRevealGuardEntries` from the resolved candidates. Resolution is
 * asynchronous (a Promise settled on a microtask), so if the next provider
 * stream's text deltas reached `drainSentinelGuardedText` before priming
 * settled they would guard against an EMPTY entry list and an echoed
 * plaintext would cross SSE raw (the persisted row still redacts, but the
 * live transcript flashed the secret). The dispatcher therefore awaits any
 * in-flight priming before guarding a `text_delta` and before the
 * end-of-message guard flush.
 *
 * The candidate value is the plaintext the reveal ROUTE
 * served (captured on the success record), so resolution no longer re-reads
 * the vault for a proven ref — the store mock below stays untouched on the
 * proven path and is only exercised by the deliberate store-fallback case.
 * The barrier still holds across the priming microtask, which the
 * concurrent-dispatch test asserts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "../__tests__/feature-flag-test-helpers.js";

// ── Store mock: reads stay pending until the test releases them ──────────
// Only reached on the store-fallback path (a ref with no proven value); the
// proven path redacts the route-served bytes without touching the store.

type StoreRelease = (value: string | null) => void;
const pendingStoreReads: StoreRelease[] = [];

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: (_key: string) =>
    new Promise<string | null>((resolve) => {
      pendingStoreReads.push(resolve);
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
}));

// ── Persistence mocks (same shape as tool-preview-lifecycle.test.ts) ─────

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getConversation: () => null,
  getMessageById: () => null,
  updateMessageContent: () => {},
  markMessageContentInflight: () => {},
  finalizeMessageContent: () => {},
  provenanceFromTrustContext: () => ({}),
  reserveMessage: () => "reserved-message-id",
  recordConversationPersistedSeq: () => {},
  getConversationPersistedSeq: () => null,
}));

mock.module("../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
}));

mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

mock.module("../plugins/defaults/memory/memory-recall-log-store.js", () => ({
  backfillMemoryRecallLogMessageId: () => {},
}));

mock.module("../plugins/defaults/memory/v2/activation-log-store.js", () => ({
  backfillMemoryV2ActivationMessageId: () => {},
}));

// ── Imports (after mocks) ────────────────────────────────────────────────

import type { AgentEvent } from "../agent/loop.js";
import type { AssistantEvent } from "../api/index.js";
import type { EventHandlerDeps } from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  dispatchAgentEvent,
} from "../daemon/conversation-agent-loop-handlers.js";
import { _resetStreamStateForTesting } from "../runtime/assistant-stream-state.js";
import {
  _resetRevealNoncesForTest,
  conversationRevealNonce,
} from "../runtime/reveal-nonce.js";
import {
  _resetRevealSuccessRegistryForTest,
  recordRevealSuccess,
} from "../runtime/reveal-success-registry.js";
import { mockUnownedModeSessions } from "./helpers/mock-conversation.js";
import {
  SYNTHETIC_OPAQUE_CREDENTIAL,
  SYNTHETIC_OPENAI_PROJECT_KEY,
} from "./secret-fixtures.js";

function toolResults(events: AssistantEvent[]): string[] {
  return events
    .filter(
      (e): e is Extract<AssistantEvent, { type: "tool_result" }> =>
        (e as { type?: string }).type === "tool_result",
    )
    .map((e) => (typeof e.result === "string" ? e.result : ""));
}

function createMockDeps(collected: AssistantEvent[]): EventHandlerDeps {
  return {
    ctx: {
      conversationId: "test-conversation",
      provider: { name: "anthropic" },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
      modeSessions: mockUnownedModeSessions(),
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (msg: AssistantEvent) => {
      collected.push(msg);
    },
    reqId: "test-req-id",
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }) as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: "cadet",
      assistantMessageChannel: "cadet",
    } as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    } as EventHandlerDeps["turnInterfaceContext"],
  } as EventHandlerDeps;
}

function streamedText(events: AssistantEvent[]): string {
  return events
    .filter(
      (e): e is Extract<AssistantEvent, { type: "assistant_text_delta" }> =>
        (e as { type?: string }).type === "assistant_text_delta",
    )
    .map((e) => e.text)
    .join("");
}

const REVEAL_TOOL_USE = {
  type: "tool_use",
  id: "toolu_reveal",
  name: "bash",
  input: {
    command: "assistant credentials reveal --service openai --field api_key",
  },
} as Extract<AgentEvent, { type: "tool_use" }>;

const REVEAL_TOOL_RESULT = {
  type: "tool_result",
  toolUseId: "toolu_reveal",
  content: "(revealed value printed to stdout)",
  isError: false,
} as Extract<AgentEvent, { type: "tool_result" }>;

beforeEach(() => {
  // Real flag resolution: only chat-credential-reveal is enabled.
  setOverridesForTesting({ "chat-credential-reveal": true });

  _resetStreamStateForTesting();
  _resetRevealSuccessRegistryForTest();
  _resetRevealNoncesForTest();
  pendingStoreReads.length = 0;
});

describe("reveal stdout redaction on the live tool_result", () => {
  test("an opaque revealed value in the reveal's own stdout is redacted before emit", async () => {
    const events: AssistantEvent[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // The reveal prints an opaque/manual token the scanner cannot classify.
    // Without redaction here the live tool card would show it raw until a
    // history refetch; the emitted tool_result must already hide it.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess(
      "openai",
      "api_key",
      SYNTHETIC_OPAQUE_CREDENTIAL,
      conversationRevealNonce("test-conversation"),
    );
    await dispatchAgentEvent(state, deps, {
      type: "tool_result",
      toolUseId: "toolu_reveal",
      content: `value: ${SYNTHETIC_OPAQUE_CREDENTIAL}`,
      isError: false,
    } as Extract<AgentEvent, { type: "tool_result" }>);

    const results = toolResults(events);
    expect(results.length).toBe(1);
    expect(results[0]).not.toContain(SYNTHETIC_OPAQUE_CREDENTIAL);
    expect(results[0]).toContain("<redacted");
    expect(pendingStoreReads.length).toBe(0);
  });

  test("buffers the RAW tool result so persist redacts exactly once", async () => {
    const events: AssistantEvent[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // The live emit is redacted, but the pending buffer must keep the raw
    // bytes: every persist path redacts via buildToolResultBlocks, and
    // buffering already-redacted content would redact twice — a candidate
    // value overlapping the marker's own text would corrupt the persisted
    // marker on the second pass.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess(
      "openai",
      "api_key",
      SYNTHETIC_OPAQUE_CREDENTIAL,
      conversationRevealNonce("test-conversation"),
    );
    await dispatchAgentEvent(state, deps, {
      type: "tool_result",
      toolUseId: "toolu_reveal",
      content: `value: ${SYNTHETIC_OPAQUE_CREDENTIAL}`,
      isError: false,
    } as Extract<AgentEvent, { type: "tool_result" }>);

    expect(toolResults(events)[0]).not.toContain(SYNTHETIC_OPAQUE_CREDENTIAL);
    expect(state.pendingToolResults.get("toolu_reveal")?.content).toBe(
      `value: ${SYNTHETIC_OPAQUE_CREDENTIAL}`,
    );
  });

  test("a tool_result that never revealed anything is forwarded unchanged", async () => {
    const events: AssistantEvent[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // No reveal staged/proven — the fast path must not alter ordinary output.
    await dispatchAgentEvent(state, deps, {
      type: "tool_use",
      id: "toolu_ls",
      name: "bash",
      input: { command: "ls -la" },
    } as Extract<AgentEvent, { type: "tool_use" }>);
    await dispatchAgentEvent(state, deps, {
      type: "tool_result",
      toolUseId: "toolu_ls",
      content: "total 0\ndrwxr-xr-x  2 user  staff",
      isError: false,
    } as Extract<AgentEvent, { type: "tool_result" }>);

    const results = toolResults(events);
    expect(results[0]).toBe("total 0\ndrwxr-xr-x  2 user  staff");
    expect(pendingStoreReads.length).toBe(0);
  });
});

function outputChunks(events: AssistantEvent[]): string[] {
  return events
    .filter(
      (e): e is Extract<AssistantEvent, { type: "tool_output_chunk" }> =>
        (e as { type?: string }).type === "tool_output_chunk",
    )
    .map((e) => e.chunk);
}

describe("live tool output chunk redaction", () => {
  test("reveal stdout chunks are redacted before forwarding", async () => {
    const events: AssistantEvent[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // The chunk streams WHILE the tool runs — before any tool_result — and
    // the drawer renders it live. The route recorded its success before the
    // CLI could print, so the guard has the proven value synchronously.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess(
      "openai",
      "api_key",
      SYNTHETIC_OPAQUE_CREDENTIAL,
      conversationRevealNonce("test-conversation"),
    );
    await dispatchAgentEvent(state, deps, {
      type: "tool_output_chunk",
      toolUseId: "toolu_reveal",
      chunk: `value: ${SYNTHETIC_OPAQUE_CREDENTIAL}\n`,
    } as Extract<AgentEvent, { type: "tool_output_chunk" }>);

    const streamedChunks = outputChunks(events).join("");
    expect(streamedChunks).not.toContain(SYNTHETIC_OPAQUE_CREDENTIAL);
    expect(streamedChunks).toContain('<redacted type="Credential" />');
    // Synchronous path — the guard never touches the store.
    expect(pendingStoreReads.length).toBe(0);
  });

  test("a value split across chunks is held back, then flushed redacted", async () => {
    const events: AssistantEvent[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess(
      "openai",
      "api_key",
      SYNTHETIC_OPAQUE_CREDENTIAL,
      conversationRevealNonce("test-conversation"),
    );
    const head = SYNTHETIC_OPAQUE_CREDENTIAL.slice(0, 8);
    const tail = SYNTHETIC_OPAQUE_CREDENTIAL.slice(8);
    await dispatchAgentEvent(state, deps, {
      type: "tool_output_chunk",
      toolUseId: "toolu_reveal",
      chunk: `out: ${head}`,
    } as Extract<AgentEvent, { type: "tool_output_chunk" }>);
    // The partial prefix is held — nothing containing it is emitted yet.
    expect(outputChunks(events).join("")).toBe("out: ");
    await dispatchAgentEvent(state, deps, {
      type: "tool_output_chunk",
      toolUseId: "toolu_reveal",
      chunk: `${tail} done`,
    } as Extract<AgentEvent, { type: "tool_output_chunk" }>);

    const streamedChunks = outputChunks(events).join("");
    expect(streamedChunks).toBe('out: <redacted type="Credential" /> done');
    expect(pendingStoreReads.length).toBe(0);
  });

  test("a held remainder is DISCARDED at tool_result, never emitted raw", async () => {
    const events: AssistantEvent[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess(
      "openai",
      "api_key",
      SYNTHETIC_OPAQUE_CREDENTIAL,
      conversationRevealNonce("test-conversation"),
    );
    // The stream ends mid-value: the tail is held when the result arrives.
    const head = SYNTHETIC_OPAQUE_CREDENTIAL.slice(0, 8);
    await dispatchAgentEvent(state, deps, {
      type: "tool_output_chunk",
      toolUseId: "toolu_reveal",
      chunk: `out: ${head}`,
    } as Extract<AgentEvent, { type: "tool_output_chunk" }>);
    await dispatchAgentEvent(state, deps, {
      type: "tool_result",
      toolUseId: "toolu_reveal",
      content: `out: ${SYNTHETIC_OPAQUE_CREDENTIAL}`,
      isError: false,
    } as Extract<AgentEvent, { type: "tool_result" }>);

    // The held bytes are a raw credential prefix that complete-value
    // redaction cannot mask — they must never reach the wire. The redacted
    // final result supersedes the streamed view, so nothing is lost.
    const streamedChunks = outputChunks(events).join("");
    expect(streamedChunks).toBe("out: ");
    expect(streamedChunks).not.toContain(head);
    expect(state.toolOutputGuardBuffers.size).toBe(0);
    const results = toolResults(events);
    expect(results[0]).toBe('out: <redacted type="Credential" />');
    expect(results[0]).not.toContain(SYNTHETIC_OPAQUE_CREDENTIAL);
  });

  test("chunks from a tool with no reveal candidates pass through verbatim", async () => {
    const events: AssistantEvent[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    await dispatchAgentEvent(state, deps, {
      type: "tool_use",
      id: "toolu_ls",
      name: "bash",
      input: { command: "ls -la" },
    } as Extract<AgentEvent, { type: "tool_use" }>);
    await dispatchAgentEvent(state, deps, {
      type: "tool_output_chunk",
      toolUseId: "toolu_ls",
      chunk: "total 0\n",
    } as Extract<AgentEvent, { type: "tool_output_chunk" }>);

    expect(outputChunks(events)).toEqual(["total 0\n"]);
    expect(pendingStoreReads.length).toBe(0);
  });

  test("a later tool echoing an already-promoted value is redacted too", async () => {
    const events: AssistantEvent[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // Tool 1: the reveal, promoted at its result.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess(
      "openai",
      "api_key",
      SYNTHETIC_OPAQUE_CREDENTIAL,
      conversationRevealNonce("test-conversation"),
    );
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_RESULT);
    // Tool 2: `echo <value>` — no reveal staged, but the promoted turn
    // candidates must still guard its live stdout.
    await dispatchAgentEvent(state, deps, {
      type: "tool_use",
      id: "toolu_echo",
      name: "bash",
      input: { command: "echo it back" },
    } as Extract<AgentEvent, { type: "tool_use" }>);
    await dispatchAgentEvent(state, deps, {
      type: "tool_output_chunk",
      toolUseId: "toolu_echo",
      chunk: `${SYNTHETIC_OPAQUE_CREDENTIAL}\n`,
    } as Extract<AgentEvent, { type: "tool_output_chunk" }>);

    const streamedChunks = outputChunks(events).join("");
    expect(streamedChunks).not.toContain(SYNTHETIC_OPAQUE_CREDENTIAL);
    expect(streamedChunks).toContain('<redacted type="Credential" />');
  });
});
