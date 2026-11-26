import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";

import OpenAI from "openai";

import { ProviderError } from "../../../util/errors.js";
import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";

function providerThatThrows(error: unknown): OpenAIChatCompletionsProvider {
  const provider = new OpenAIChatCompletionsProvider("test-key", "test-model", {
    baseURL: "http://127.0.0.1:1/v1",
    providerName: "openai-compatible",
    providerLabel: "OpenAI-compatible",
  });
  Object.assign(provider["client"].chat.completions, {
    create: async () => {
      throw error;
    },
  });
  return provider;
}

describe("connection-error wrapping", () => {
  test("wraps APIConnectionError with reason network_error and the original as cause", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const sdkError = new OpenAI.APIConnectionError({ cause });
    const thrown = await providerThatThrows(sdkError)
      .sendMessage([{ role: "user", content: [{ type: "text", text: "hi" }] }])
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert(thrown instanceof ProviderError, "Expected ProviderError");
    const providerError = thrown;
    expect(providerError.reason).toBe("network_error");
    expect(providerError.statusCode).toBeUndefined();
    expect(providerError.cause).toBe(sdkError);
  });
});
