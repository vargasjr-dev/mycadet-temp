import { describe, expect, test } from "bun:test";

import type Anthropic from "@anthropic-ai/sdk";

import { AnthropicProvider } from "../client.js";

function makeMessage(): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-fable-5-2",
    stop_sequence: null,
    content: [{ type: "text", text: "ok", citations: null }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  } as Anthropic.Message;
}

/**
 * Stub the SDK client on a provider instance — every stream call records the
 * merged params (the client spreads `betas` into them for the beta endpoint)
 * and resolves to an end_turn message.
 */
function stubProvider(model: string): {
  provider: AnthropicProvider;
  calls: Array<Record<string, unknown>>;
} {
  const provider = new AnthropicProvider("test-key", model);
  const calls: Array<Record<string, unknown>> = [];
  const stream = (params: unknown) => {
    calls.push(params as Record<string, unknown>);
    return {
      on() {
        return this;
      },
      async finalMessage() {
        return makeMessage();
      },
    };
  };
  (provider as unknown as { client: unknown }).client = {
    baseURL: "https://api.anthropic.com",
    messages: { stream },
    beta: { messages: { stream } },
  };
  return { provider, calls };
}

describe("thinking-block binding controls", () => {
  test("requests carry the binding beta and drop stale blocks instead of failing", async () => {
    const { provider, calls } = stubProvider("claude-fable-5-2");
    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { config: { thinking: { type: "adaptive" } } },
    );
    expect(calls.length).toBe(1);
    expect(calls[0].betas).toContain("thinking-binding-controls-2026-08-01");
    const thinking = calls[0].thinking as Record<string, unknown>;
    expect(thinking.block_binding).toEqual({
      prefix_mismatch_behavior: "drop_block",
    });
  });

  test("the original thinking config fields survive the merge", async () => {
    const { provider, calls } = stubProvider("claude-fable-5-2");
    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { config: { thinking: { type: "enabled", budget_tokens: 2048 } } },
    );
    const thinking = calls[0].thinking as Record<string, unknown>;
    expect(thinking.type).toBe("enabled");
    expect(thinking.budget_tokens).toBe(2048);
    expect(thinking.block_binding).toEqual({
      prefix_mismatch_behavior: "drop_block",
    });
  });

  test("calls without thinking carry no block_binding", async () => {
    const { provider, calls } = stubProvider("claude-fable-5-2");
    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(calls[0].thinking).toBeUndefined();
    // The binding beta still rides (it is inert without thinking blocks).
    expect(calls[0].betas).toContain("thinking-binding-controls-2026-08-01");
  });

  test("Haiku requests stay on the plain endpoint without the binding field", async () => {
    const { provider, calls } = stubProvider("claude-haiku-4-5");
    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { config: { thinking: { type: "adaptive" } } },
    );
    expect(calls[0].betas).toBeUndefined();
    const thinking = calls[0].thinking as Record<string, unknown> | undefined;
    expect(thinking?.block_binding).toBeUndefined();
  });
});
