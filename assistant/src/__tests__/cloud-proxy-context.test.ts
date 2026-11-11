import { beforeEach, describe, expect, test } from "bun:test";

import {
  buildCloudBaseUrl,
  hasCloudProxyPrereqs,
  managedFallbackEnabledFor,
  resolveCloudProxyContext,
} from "../providers/cloud-proxy/context.js";
import { credentialKey } from "../security/credential-key.js";
import { useMemorySecureKeyMap } from "./helpers/secure-keys.js";
import { setConfig } from "./helpers/set-config.js";

// The REAL secure-keys module pinned to a live memory backend.
const secureKeys = useMemorySecureKeyMap();
const ASSISTANT_API_KEY = credentialKey("cadet", "assistant_api_key");

const TEST_CLOUD_BASE_URL = "https://platform.example.com";

/**
 * The real `getCloudBaseUrl()` never returns an empty string — unset config
 * falls through `CADET_CLOUD_URL` to the `CADET_ENVIRONMENT` default — so
 * the "no platform URL" cases below assert the real fallback shape (a
 * nonempty default URL) instead of the empty string the old
 * `mock.module("../config/env.js")` stub produced. Disabling the proxy for
 * real means the assistant API key is missing.
 */
function setCloudBaseUrl(url: string | undefined): void {
  setConfig("cloud", { baseUrl: url ?? "" });
}

describe("resolveCloudProxyContext", () => {
  beforeEach(() => {
    setCloudBaseUrl(undefined);
    secureKeys.delete(ASSISTANT_API_KEY);
  });

  test("falls back to the environment default URL when config is unset", async () => {
    secureKeys.set(ASSISTANT_API_KEY, "sk-test-key");

    const ctx = await resolveCloudProxyContext();
    expect(ctx.enabled).toBe(true);
    expect(ctx.cloudBaseUrl.length).toBeGreaterThan(0);
  });

  test("returns disabled when assistant API key is missing", async () => {
    setCloudBaseUrl(TEST_CLOUD_BASE_URL);
    secureKeys.delete(ASSISTANT_API_KEY);

    const ctx = await resolveCloudProxyContext();
    expect(ctx.enabled).toBe(false);
    expect(ctx.assistantApiKey).toBe("");
  });

  test("returns disabled when both are missing", async () => {
    const ctx = await resolveCloudProxyContext();
    expect(ctx.enabled).toBe(false);
  });

  test("returns enabled when both platform URL and API key are present", async () => {
    setCloudBaseUrl(`${TEST_CLOUD_BASE_URL}/`);
    secureKeys.set(ASSISTANT_API_KEY, "sk-test-key");

    const ctx = await resolveCloudProxyContext();
    expect(ctx.enabled).toBe(true);
    expect(ctx.cloudBaseUrl).toBe(TEST_CLOUD_BASE_URL);
    expect(ctx.assistantApiKey).toBe("sk-test-key");
  });

  test("strips trailing slashes from platform URL", async () => {
    setCloudBaseUrl(`${TEST_CLOUD_BASE_URL}///`);
    secureKeys.set(ASSISTANT_API_KEY, "sk-test-key");

    const ctx = await resolveCloudProxyContext();
    expect(ctx.cloudBaseUrl).toBe(TEST_CLOUD_BASE_URL);
  });
});

describe("hasCloudProxyPrereqs", () => {
  beforeEach(() => {
    setCloudBaseUrl(undefined);
    secureKeys.delete(ASSISTANT_API_KEY);
  });

  test("returns false when prerequisites are missing", async () => {
    expect(await hasCloudProxyPrereqs()).toBe(false);
  });

  test("returns true when prerequisites are satisfied", async () => {
    setCloudBaseUrl(TEST_CLOUD_BASE_URL);
    secureKeys.set(ASSISTANT_API_KEY, "sk-test-key");
    expect(await hasCloudProxyPrereqs()).toBe(true);
  });
});

describe("buildCloudBaseUrl", () => {
  beforeEach(() => {
    setCloudBaseUrl(TEST_CLOUD_BASE_URL);
    secureKeys.set(ASSISTANT_API_KEY, "sk-test-key");
  });

  test("builds correct URL for cloud providers", async () => {
    expect(await buildCloudBaseUrl("anthropic")).toBe(
      `${TEST_CLOUD_BASE_URL}/v1/runtime-proxy/anthropic`,
    );
    expect(await buildCloudBaseUrl("gemini")).toBe(
      `${TEST_CLOUD_BASE_URL}/v1/runtime-proxy/gemini`,
    );
    expect(await buildCloudBaseUrl("openai")).toBe(
      `${TEST_CLOUD_BASE_URL}/v1/runtime-proxy/openai`,
    );
  });

  test("returns managed URL for fireworks", async () => {
    expect(await buildCloudBaseUrl("fireworks")).toBe(
      `${TEST_CLOUD_BASE_URL}/v1/runtime-proxy/fireworks`,
    );
  });

  test("returns undefined for non-cloud providers", async () => {
    expect(await buildCloudBaseUrl("openrouter")).toBeUndefined();
    expect(await buildCloudBaseUrl("ollama")).toBeUndefined();
  });

  test("returns undefined for unknown provider", async () => {
    expect(await buildCloudBaseUrl("unknown-provider")).toBeUndefined();
  });

  test("returns undefined when prerequisites are missing", async () => {
    secureKeys.delete(ASSISTANT_API_KEY);
    expect(await buildCloudBaseUrl("anthropic")).toBeUndefined();
    expect(await buildCloudBaseUrl("gemini")).toBeUndefined();
    expect(await buildCloudBaseUrl("openai")).toBeUndefined();
  });
});

describe("managedFallbackEnabledFor", () => {
  beforeEach(() => {
    setCloudBaseUrl(TEST_CLOUD_BASE_URL);
    secureKeys.set(ASSISTANT_API_KEY, "sk-test-key");
  });

  test("returns true only for cloud fallback providers with prerequisites", async () => {
    expect(await managedFallbackEnabledFor("anthropic")).toBe(true);
    expect(await managedFallbackEnabledFor("gemini")).toBe(true);
    expect(await managedFallbackEnabledFor("openai")).toBe(true);
  });

  test("returns false for non-cloud provider", async () => {
    expect(await managedFallbackEnabledFor("ollama")).toBe(false);
  });

  test("returns false for unknown provider", async () => {
    expect(await managedFallbackEnabledFor("unknown")).toBe(false);
  });

  test("returns false when prerequisites are missing", async () => {
    secureKeys.delete(ASSISTANT_API_KEY);
    expect(await managedFallbackEnabledFor("anthropic")).toBe(false);
    expect(await managedFallbackEnabledFor("gemini")).toBe(false);
    expect(await managedFallbackEnabledFor("openai")).toBe(false);
  });
});
