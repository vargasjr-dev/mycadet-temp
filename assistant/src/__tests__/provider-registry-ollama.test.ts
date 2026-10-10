import { describe, expect, test } from "bun:test";

import { useMemorySecureKeys } from "./helpers/secure-keys.js";

useMemorySecureKeys();
import { LLMSchema } from "../config/schemas/llm.js";
import {
  getProvider,
  initializeProviders,
  listProviders,
} from "../providers/registry.js";

const baseLlm = LLMSchema.parse({});

function ollamaConfig(webSearch: { provider: "inference-provider-native" }) {
  return {
    services: {
      inference: {},
      "image-generation": {
        mode: "your-own" as const,
        provider: "gemini" as const,
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": webSearch,
    },
    llm: {
      ...baseLlm,
      // The call-site tweak is applied last, so it makes ollama the resolved
      // mainAgent provider regardless of the winning profile.
      callSites: {
        mainAgent: {
          provider: "ollama" as const,
          model: "claude-opus-4-6",
        },
      },
    },
  };
}

describe("provider registry (ollama)", () => {
  test("registers ollama when selected provider has no API key", async () => {
    await initializeProviders(
      ollamaConfig({
        provider: "inference-provider-native",
      }),
    );

    const provider = getProvider("ollama");
    expect(provider.name).toBe("ollama");
    expect(listProviders()).toEqual(["ollama"]);
  });

  test("managed native web search preference does not make ollama a cloud web-search provider", async () => {
    await initializeProviders(
      ollamaConfig({
        provider: "inference-provider-native",
      }),
    );

    const provider = getProvider("ollama");
    expect(provider.name).toBe("ollama");
    expect(listProviders()).toEqual(["ollama"]);
  });
});
