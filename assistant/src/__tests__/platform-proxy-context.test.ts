import { beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";
import { useMemorySecureKeyMap } from "./helpers/secure-keys.js";

// The REAL secure-keys module pinned to a live memory backend.
const secureKeys = useMemorySecureKeyMap();
const ASSISTANT_API_KEY = credentialKey("cadet", "assistant_api_key");

// Mutable state for env stubs
let mockCloudBaseUrl = "";

mock.module("../config/env.js", () => ({
  getCloudBaseUrl: () => mockCloudBaseUrl,
}));

import {
  buildManagedBaseUrl,
  hasManagedProxyPrereqs,
  managedFallbackEnabledFor,
  resolveManagedProxyContext,
} from "../providers/platform-proxy/context.js";

describe("resolveManagedProxyContext", () => {
  beforeEach(() => {
    mockCloudBaseUrl = "";
    secureKeys.delete(ASSISTANT_API_KEY);
  });

  test("returns disabled when platform URL is empty", async () => {
    mockCloudBaseUrl = "";
    secureKeys.set(ASSISTANT_API_KEY, "sk-test-key");

    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(false);
    expect(ctx.cloudBaseUrl).toBe("");
  });

  test("returns disabled when assistant API key is missing", async () => {
    mockCloudBaseUrl = "https://platform.example.com";
    secureKeys.delete(ASSISTANT_API_KEY);

    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(false);
    expect(ctx.assistantApiKey).toBe("");
  });

  test("returns disabled when both are missing", async () => {
    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(false);
  });

  test("returns enabled when both platform URL and API key are present", async () => {
    mockCloudBaseUrl = "https://platform.example.com/";
    secureKeys.set(ASSISTANT_API_KEY, "sk-test-key");

    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(true);
    expect(ctx.cloudBaseUrl).toBe("https://platform.example.com");
    expect(ctx.assistantApiKey).toBe("sk-test-key");
  });

  test("strips trailing slashes from platform URL", async () => {
    mockCloudBaseUrl = "https://platform.example.com///";
    secureKeys.set(ASSISTANT_API_KEY, "sk-test-key");

    const ctx = await resolveManagedProxyContext();
    expect(ctx.cloudBaseUrl).toBe("https://platform.example.com");
  });
});

describe("hasManagedProxyPrereqs", () => {
  beforeEach(() => {
    mockCloudBaseUrl = "";
    secureKeys.delete(ASSISTANT_API_KEY);
  });

  test("returns false when prerequisites are missing", async () => {
    expect(await hasManagedProxyPrereqs()).toBe(false);
  });

  test("returns true when prerequisites are satisfied", async () => {
    mockCloudBaseUrl = "https://platform.example.com";
    secureKeys.set(ASSISTANT_API_KEY, "sk-test-key");
    expect(await hasManagedProxyPrereqs()).toBe(true);
  });
});

describe("buildManagedBaseUrl", () => {
  beforeEach(() => {
    mockCloudBaseUrl = "https://platform.example.com";
    secureKeys.set(ASSISTANT_API_KEY, "sk-test-key");
  });

  test("builds correct URL for managed providers", async () => {
    expect(await buildManagedBaseUrl("anthropic")).toBe(
      "https://platform.example.com/v1/runtime-proxy/anthropic",
    );
    expect(await buildManagedBaseUrl("gemini")).toBe(
      "https://platform.example.com/v1/runtime-proxy/gemini",
    );
    expect(await buildManagedBaseUrl("openai")).toBe(
      "https://platform.example.com/v1/runtime-proxy/openai",
    );
  });

  test("returns managed URL for fireworks", async () => {
    expect(await buildManagedBaseUrl("fireworks")).toBe(
      "https://platform.example.com/v1/runtime-proxy/fireworks",
    );
  });

  test("returns undefined for non-managed providers", async () => {
    expect(await buildManagedBaseUrl("openrouter")).toBeUndefined();
    expect(await buildManagedBaseUrl("ollama")).toBeUndefined();
  });

  test("returns undefined for unknown provider", async () => {
    expect(await buildManagedBaseUrl("unknown-provider")).toBeUndefined();
  });

  test("returns undefined when prerequisites are missing", async () => {
    mockCloudBaseUrl = "";
    secureKeys.delete(ASSISTANT_API_KEY);
    expect(await buildManagedBaseUrl("anthropic")).toBeUndefined();
    expect(await buildManagedBaseUrl("gemini")).toBeUndefined();
    expect(await buildManagedBaseUrl("openai")).toBeUndefined();
  });
});

describe("managedFallbackEnabledFor", () => {
  beforeEach(() => {
    mockCloudBaseUrl = "https://platform.example.com";
    secureKeys.set(ASSISTANT_API_KEY, "sk-test-key");
  });

  test("returns true only for managed fallback providers with prerequisites", async () => {
    expect(await managedFallbackEnabledFor("anthropic")).toBe(true);
    expect(await managedFallbackEnabledFor("gemini")).toBe(true);
    expect(await managedFallbackEnabledFor("openai")).toBe(true);
  });

  test("returns false for non-managed provider", async () => {
    expect(await managedFallbackEnabledFor("ollama")).toBe(false);
  });

  test("returns false for unknown provider", async () => {
    expect(await managedFallbackEnabledFor("unknown")).toBe(false);
  });

  test("returns false when prerequisites are missing", async () => {
    mockCloudBaseUrl = "";
    secureKeys.delete(ASSISTANT_API_KEY);
    expect(await managedFallbackEnabledFor("anthropic")).toBe(false);
    expect(await managedFallbackEnabledFor("gemini")).toBe(false);
    expect(await managedFallbackEnabledFor("openai")).toBe(false);
  });
});
