import { describe, expect, test } from "bun:test";

import type { ProviderEvent } from "../../types.js";
import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";

type MockChunk = {
  choices: Array<{
    delta: {
      content?: unknown;
    };
    finish_reason?: string | null;
  }>;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

function makeStream(chunks: MockChunk[]): AsyncIterable<MockChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        yield c;
      }
    },
  };
}

function stubProvider(chunks: MockChunk[]): {
  provider: OpenAIChatCompletionsProvider;
  events: ProviderEvent[];
} {
  const provider = new OpenAIChatCompletionsProvider("test-key", "test-model");
  // Swap the SDK client for a stub whose chat.completions.create returns our
  // canned async iterable.
  Object.assign(provider["client"].chat.completions, {
    create: async () => makeStream(chunks),
  });
  const events: ProviderEvent[] = [];
  return { provider, events };
}

describe("OpenAIChatCompletionsProvider typed response content", () => {
  test("newer Mistral typed-block deltas join into text, not [object Object]", async () => {
    // Newer Mistral models stream `delta.content` as OpenAI content parts
    // where the spec says a string. The old path concatenated the array onto
    // the running text and every response read "[object Object]".
    const { provider, events } = stubProvider([
      {
        choices: [
          {
            delta: {
              content: [
                { type: "text", text: "hello " },
                { type: "text", text: "world" },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: { content: [{ type: "text", text: "!" }] } }],
      },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    ]);

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { onEvent: (e) => events.push(e) },
    );

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas.map((d) => d.text)).toEqual(["hello world", "!"]);
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toBe("hello world!");
  });

  test("a string delta is passed through untouched and mixed shapes compose", async () => {
    const { provider, events } = stubProvider([
      { choices: [{ delta: { content: "plain " } }] },
      {
        choices: [{ delta: { content: [{ type: "text", text: "typed" }] } }],
      },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    ]);

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { onEvent: (e) => events.push(e) },
    );

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toBe("plain typed");
  });

  test("a typed block with no text contributes nothing, not its JSON", async () => {
    const { provider, events } = stubProvider([
      {
        choices: [
          {
            delta: {
              content: [
                { type: "other_kind", payload: { nested: true } },
                { type: "text", text: "visible" },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    ]);

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { onEvent: (e) => events.push(e) },
    );

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toBe("visible");
    expect(text).not.toContain("object");
  });
});
