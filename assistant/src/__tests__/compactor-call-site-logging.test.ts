/**
 * Tests that successful compaction LLM calls land an `llm_request_logs`
 * row with `call_site = "compactionAgent"`. The compactor opts out of
 * automatic usage tracking (`usageTracking: "manual"`), so its calls
 * otherwise never reach `recordRequestLog` via the agent-loop
 * dispatcher. This test pins the explicit instrumentation in
 * `compactor.ts` so visibility doesn't silently regress.
 */
import { describe, expect, test } from "bun:test";

import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

import { runAssistantDrivenCompaction } from "../context/compactor.js";
import { getRequestLogsByConversationId } from "../persistence/llm-request-log-store.js";
import type { Message, Provider } from "../providers/types.js";

const loggedRows = () => getRequestLogsByConversationId(convId);

const TAIL_TIMESTAMP =
  "2026-05-21 (Thursday) 10:00:00 -05:00 (America/Chicago)";

const compactionResponse = `
<compaction_result>
<summary>
Earlier turns summarized here.
</summary>

<key_state>
- Nothing critical pending.
</key_state>

<tail_start timestamp="${TAIL_TIMESTAMP}" preview="tail anchor message" />
</compaction_result>
`;

const RAW_REQUEST = { model: "mock-model", messages: [] };
const RAW_RESPONSE = { id: "resp-1", content: compactionResponse };

function makeProvider(): Provider {
  return {
    name: "mock-provider",
    sendMessage: async () => ({
      content: [{ type: "text", text: compactionResponse }],
      model: "mock-model",
      actualProvider: "actual-mock-provider",
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: "end_turn",
      rawRequest: RAW_REQUEST,
      rawResponse: RAW_RESPONSE,
    }),
  };
}

function makeProviderWithoutRaw(): Provider {
  return {
    name: "mock-provider",
    sendMessage: async () => ({
      content: [{ type: "text", text: compactionResponse }],
      model: "mock-model",
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: "end_turn",
      // rawRequest/rawResponse intentionally absent — best-effort skip path.
    }),
  };
}

let convSeq = 0;

const userText = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

const userTextWithTurnContext = (text: string, timestamp: string): Message => ({
  role: "user",
  content: [
    {
      type: "text",
      text: `<turn_context>\ncurrent_time: ${timestamp}\n</turn_context>\n${text}`,
    },
  ],
});

const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

function buildMessages(): Message[] {
  return [
    userText("old user turn 1"),
    assistantText("old assistant reply 1"),
    userText("old user turn 2"),
    assistantText("old assistant reply 2"),
    userTextWithTurnContext("tail anchor message", TAIL_TIMESTAMP),
    assistantText("tail assistant reply"),
  ];
}

let convId = "";
const args = (provider: Provider) => ({
  conversationId: (convId = `conv-compaction-log-${++convSeq}`),
  messages: buildMessages(),
  provider,
  systemPrompt: "you are a test assistant",
  compaction: { enabled: true, autoThreshold: 0.7 },
  maxInputTokens: 1000,
  // Above threshold so the auto-check fires.
  previousEstimatedInputTokens: 900,
});

describe("compactor records llm_request_logs with call_site=compactionAgent", () => {
  test("successful compaction call stamps call_site = compactionAgent", async () => {
    const result = await runAssistantDrivenCompaction(args(makeProvider()));

    const rows = loggedRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.callSite).toBe("compactionAgent");
    expect(result.summaryCallSite).toBe("compactionAgent");
    expect(result.summaryResolutionCallSite).toBe("mainAgent");
    expect(rows[0]!.conversationId).toBe(convId);
    // Provider name comes from actualProvider when present.
    expect(rows[0]!.provider).toBe("actual-mock-provider");
    // Payloads should be JSON-stringified.
    expect(rows[0]!.requestPayload).toBe(JSON.stringify(RAW_REQUEST));
    expect(rows[0]!.responsePayload).toBe(JSON.stringify(RAW_RESPONSE));
  });

  test("skips persistence when provider returns no rawRequest/rawResponse", async () => {
    await runAssistantDrivenCompaction(args(makeProviderWithoutRaw()));

    // Helper short-circuits when raw payloads are absent — non-fatal.
    expect(loggedRows().length).toBe(0);
  });

  test("uses provider.name when actualProvider is absent", async () => {
    const provider: Provider = {
      name: "fallback-provider-name",
      sendMessage: async () => ({
        content: [{ type: "text", text: compactionResponse }],
        model: "mock-model",
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "end_turn",
        rawRequest: RAW_REQUEST,
        rawResponse: RAW_RESPONSE,
      }),
    };

    await runAssistantDrivenCompaction(args(provider));

    const rows = loggedRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.provider).toBe("fallback-provider-name");
    expect(rows[0]!.callSite).toBe("compactionAgent");
  });
});

describe("compaction result reports what actually served the summary", () => {
  test("rerouted summary carries the backup provider and profile", async () => {
    // `RetryProvider` escalated the summary call to a backup profile on
    // another provider and stamped the response, so the result must report
    // the backup even though the compactor resolved `primaryProfile`.
    const provider: Provider = {
      name: "openai",
      sendMessage: async () => ({
        content: [{ type: "text", text: compactionResponse }],
        model: "claude-sonnet-5",
        actualProvider: "anthropic",
        actualInferenceProfile: "backupProfile",
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "end_turn",
        rawRequest: RAW_REQUEST,
        rawResponse: RAW_RESPONSE,
      }),
    };

    const result = await runAssistantDrivenCompaction({
      ...args(provider),
      overrideProfile: "primaryProfile",
    });

    expect(result.summaryModel).toBe("claude-sonnet-5");
    expect(result.summaryActualProvider).toBe("anthropic");
    expect(result.summaryActualInferenceProfile).toBe("backupProfile");
    // The primary's resolution is still reported, just outranked downstream.
    expect(result.summaryOverrideProfile).toBe("primaryProfile");
    // Request log and usage attribution share the observability call site.
    expect(result.summaryCallSite).toBe("compactionAgent");
    expect(result.summaryResolutionCallSite).toBe("mainAgent");
    expect(loggedRows()[0]!.callSite).toBe("compactionAgent");
    // Same value the request log recorded: one source of truth, not two.
    expect(loggedRows()[0]!.provider).toBe("anthropic");
  });

  test("non-rerouted summary carries the configured provider and no profile", async () => {
    const provider: Provider = {
      name: "openai",
      sendMessage: async () => ({
        content: [{ type: "text", text: compactionResponse }],
        model: "mock-model",
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "end_turn",
        rawRequest: RAW_REQUEST,
        rawResponse: RAW_RESPONSE,
      }),
    };

    const result = await runAssistantDrivenCompaction({
      ...args(provider),
      overrideProfile: "primaryProfile",
    });

    expect(result.summaryActualProvider).toBe("openai");
    expect(result.summaryActualInferenceProfile).toBeUndefined();
    expect(result.summaryOverrideProfile).toBe("primaryProfile");
  });
});
