/**
 * Tests for cloud proxy Gemini embedding backend selection.
 *
 * Verifies that selectEmbeddingBackend correctly routes through the
 * cloud proxy when cloud proxy prerequisites are satisfied.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";
import { useMemorySecureKeyMap } from "./helpers/secure-keys.js";

// The REAL secure-keys module pinned to a live memory backend.
const secureKeys = useMemorySecureKeyMap();

// ---------------------------------------------------------------------------
// Mocks — must be before importing the module under test
// ---------------------------------------------------------------------------

// Mutable state for cloud proxy context
let mockCloudBaseUrl = "";
// Managed + provider keys live in the real backend's store now.
const ASSISTANT_API_KEY = credentialKey("cadet", "assistant_api_key");

mock.module("../config/env.js", () => ({
  getCloudBaseUrl: () => mockCloudBaseUrl,
  getOllamaBaseUrlEnv: () => "",
}));

// Feature flag mock — always returns true (flag is GA'ed)

import type { AssistantConfig } from "../config/types.js";
import {
  clearEmbeddingBackendCache,
  selectEmbeddingBackend,
} from "../persistence/embeddings/embedding-backend.js";
import { GeminiEmbeddingBackend } from "../persistence/embeddings/embedding-gemini.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLATFORM_BASE = "https://test-cloud.mycadet.ai";
const MANAGED_API_KEY = "ast-managed-key-123";

function enableCloudProxy() {
  mockCloudBaseUrl = PLATFORM_BASE;
  secureKeys.set(ASSISTANT_API_KEY, MANAGED_API_KEY);
}

function disableCloudProxy() {
  mockCloudBaseUrl = "";
  secureKeys.delete(ASSISTANT_API_KEY);
}

function makeConfig(
  overrides: {
    provider?: string;
    geminiModel?: string;
    geminiDimensions?: number;
  } = {},
): AssistantConfig {
  return {
    memory: {
      embeddings: {
        provider: overrides.provider ?? "auto",
        localModel: "Xenova/bge-small-en-v1.5",
        openaiModel: "text-embedding-3-small",
        geminiModel: overrides.geminiModel ?? "gemini-embedding-2",
        geminiDimensions: overrides.geminiDimensions,
        ollamaModel: "nomic-embed-text",
      },
      qdrant: {
        vectorSize: 384,
      },
    },
    services: {
      inference: { provider: "anthropic" },
    },
  } as unknown as AssistantConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Real flag resolution replaces the former blanket module mock.
  disableCloudProxy();
  secureKeys.clear(); // wipe provider keys; disableCloudProxy already cleared the assistant key
  clearEmbeddingBackendCache();
});

afterEach(() => {
  clearEmbeddingBackendCache();
});

describe("cloud proxy Gemini embedding selection", () => {
  test("selects cloud proxy Gemini when proxy context available", async () => {
    enableCloudProxy();
    const config = makeConfig();

    const { backend, reason } = await selectEmbeddingBackend(config);

    expect(backend).not.toBeNull();
    expect(backend).toBeInstanceOf(GeminiEmbeddingBackend);
    expect(backend!.provider).toBe("gemini");
    expect(reason).toBeNull();
  });

  test("cloud proxy backend uses default 3072 dimensions when geminiDimensions not set", async () => {
    enableCloudProxy();
    const config = makeConfig();

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).toBeInstanceOf(GeminiEmbeddingBackend);
    // Access the private dimensions field to verify default
    const dimensions = (backend as unknown as { dimensions: number })
      .dimensions;
    expect(dimensions).toBe(3072);
  });

  test("cloud proxy backend uses explicit geminiDimensions when set", async () => {
    enableCloudProxy();
    const config = makeConfig({ geminiDimensions: 768 });

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).toBeInstanceOf(GeminiEmbeddingBackend);
    const dimensions = (backend as unknown as { dimensions: number })
      .dimensions;
    expect(dimensions).toBe(768);
  });

  test("cloud proxy backend uses cloudBaseUrl (not direct Google API)", async () => {
    enableCloudProxy();
    const config = makeConfig();

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).toBeInstanceOf(GeminiEmbeddingBackend);
    const cloudBaseUrl = (backend as unknown as { cloudBaseUrl: string })
      .cloudBaseUrl;
    expect(cloudBaseUrl).toBe(`${PLATFORM_BASE}/v1/runtime-proxy/gemini`);
  });

  test("falls back to local when cloud proxy context unavailable", async () => {
    disableCloudProxy();
    const config = makeConfig();

    const { backend } = await selectEmbeddingBackend(config);

    // With auto and no provider keys or proxy, falls through to local
    expect(backend).not.toBeNull();
    expect(backend!.provider).toBe("local");
  });

  test("selects cloud proxy when provider is explicitly gemini", async () => {
    enableCloudProxy();
    const config = makeConfig({ provider: "gemini" });

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).toBeInstanceOf(GeminiEmbeddingBackend);
    const cloudBaseUrl = (backend as unknown as { cloudBaseUrl: string })
      .cloudBaseUrl;
    expect(cloudBaseUrl).toContain("/v1/runtime-proxy/gemini");
  });

  test("does not use cloud proxy when provider is explicitly local", async () => {
    enableCloudProxy();
    const config = makeConfig({ provider: "local" });

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).not.toBeNull();
    expect(backend!.provider).toBe("local");
  });

  test("does not use cloud proxy when provider is explicitly openai", async () => {
    enableCloudProxy();
    secureKeys.set(credentialKey("openai", "api_key"), "user-openai-key");
    const config = makeConfig({ provider: "openai" });

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).not.toBeNull();
    expect(backend!.provider).toBe("openai");
  });

  test("direct Gemini key still works without cloud proxy", async () => {
    disableCloudProxy();
    secureKeys.set(credentialKey("gemini", "api_key"), "user-gemini-key");
    const config = makeConfig({ provider: "gemini" });

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).toBeInstanceOf(GeminiEmbeddingBackend);
    expect(backend!.provider).toBe("gemini");
    // Should NOT use cloud proxy
    const cloudBaseUrl = (backend as unknown as { cloudBaseUrl?: string })
      .cloudBaseUrl;
    expect(cloudBaseUrl).toBeUndefined();
  });
});
