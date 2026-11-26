import { describe, expect, test } from "bun:test";

import { AnthropicProvider } from "../client.js";

function makeMessage() {
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
  };
}

/**
 * Stub the SDK client on a provider instance — every stream call records the
 * merged params (the client spreads `betas` into them for the beta endpoint)
 * and resolves to an end_turn message.
 */
interface CapturedParams {
  betas?: string[];
  thinking?: { type?: string; budget_tokens?: number; block_binding?: unknown };
}
function stubProvider(model: string) {
  const provider = new AnthropicProvider("test-key", model);
  const calls: CapturedParams[] = [];
  const stream = (params: CapturedParams) => {
    calls.push(params);
    return {
      on() {
        return this;
      },
      async finalMessage() {
        return makeMessage();
      },
    };
  };
  Object.assign(provider["client"], { baseURL: "https://api.anthropic.com" });
  Object.assign(provider["client"].messages, { stream });
  Object.assign(provider["client"].beta.messages, { stream });
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
    const thinking = calls[0].thinking!;
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
    const thinking = calls[0].thinking!;
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
    const thinking = calls[0].thinking;
    expect(thinking?.block_binding).toBeUndefined();
  });
});
