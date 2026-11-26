import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";

import OpenAI from "openai";

import { ProviderError } from "../../../util/errors.js";
import { ContextOverflowError, type SendMessageOptions } from "../../types.js";
import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";

class ExtraBodyProvider extends OpenAIChatCompletionsProvider {
  protected override buildRequestExtraBody(
    _options?: SendMessageOptions,
  ): Record<string, unknown> | undefined {
    return { directions: { companion: 0.4 } };
  }
}

describe("chat-completions extraBody", () => {
  test("merges subclass extra body fields onto the SDK create params", async () => {
    const provider = new ExtraBodyProvider("test-key", "qwen/qwen3-8b");
    let seenParams: Record<string, unknown> | undefined;
    let seenOptions: Record<string, unknown> | undefined;
    Object.assign(provider["client"].chat.completions, {
      create: async (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => {
        seenParams = params;
        seenOptions = options;
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        };
      },
    });

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(seenParams?.directions).toEqual({ companion: 0.4 });
    expect(seenOptions?.extraBody).toBeUndefined();
  });

  test("attaches the SDK create params as ProviderError.rawRequest on 4xx", async () => {
    const provider = new ExtraBodyProvider("test-key", "qwen/qwen3-8b", {
      providerName: "cadet",
      providerLabel: "Cadet",
    });
    Object.assign(provider["client"].chat.completions, {
      create: async () => {
        throw new OpenAI.APIError(
          400,
          { detail: "directions are not loaded" },
          undefined,
          new Headers(),
        );
      },
    });

    try {
      await provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ]);
      throw new Error("expected ProviderError");
    } catch (error) {
      assert(error instanceof ProviderError, "Expected ProviderError");
      const rejected = error;
      expect(rejected.provider).toBe("cadet");
      expect(rejected.statusCode).toBe(400);
      expect(rejected.rawRequest).toEqual(
        expect.objectContaining({
          model: "qwen/qwen3-8b",
          directions: { companion: 0.4 },
        }),
      );
    }
  });

  test("attaches the SDK create params as ContextOverflowError.rawRequest", async () => {
    const provider = new ExtraBodyProvider("test-key", "qwen/qwen3-8b", {
      providerName: "cadet",
      providerLabel: "Cadet",
    });
    Object.assign(provider["client"].chat.completions, {
      create: async () => {
        throw new OpenAI.APIError(
          400,
          {
            message:
              "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.",
            type: "invalid_request_error",
            code: "context_length_exceeded",
          },
          undefined,
          new Headers(),
        );
      },
    });

    try {
      await provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ]);
      throw new Error("expected ContextOverflowError");
    } catch (error) {
      assert(
        error instanceof ContextOverflowError,
        "Expected ContextOverflowError",
      );
      const rejected = error;
      expect(rejected.provider).toBe("cadet");
      expect(rejected.rawRequest).toEqual(
        expect.objectContaining({
          model: "qwen/qwen3-8b",
          directions: { companion: 0.4 },
        }),
      );
    }
  });
});
