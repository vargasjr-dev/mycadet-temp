/**
 * Cloud proxy context resolver.
 *
 * Resolves the prerequisites for routing LLM provider requests through the
 * platform's cloud proxy: the cloud base URL and an assistant API key
 * stored as a secure credential.
 *
 * When both are present, providers can be initialized with a cloud proxy
 * base URL instead of calling the upstream provider directly.
 */

import { getCloudBaseUrl } from "../../config/env.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { PLATFORM_PROVIDER_META } from "./constants.js";

/** Storage key for the assistant API key credential. */
const ASSISTANT_API_KEY_STORAGE_KEY = credentialKey(
  "cadet",
  "assistant_api_key",
);

export interface CloudProxyContext {
  /** Whether cloud proxy prerequisites are satisfied. */
  enabled: boolean;
  /** Platform base URL (without trailing slash), or empty string if unavailable. */
  cloudBaseUrl: string;
  /** Assistant API key for authenticating with the cloud proxy, or empty string if unavailable. */
  assistantApiKey: string;
}

/**
 * Cached result of the last `resolveCloudProxyContext()` call.
 * Updated every time the context is resolved (startup, credential changes).
 * Defaults to `false` so that callers see a safe value before the first
 * async resolution completes.
 */
let _managedProxyEnabled = false;

/**
 * Resolve cloud proxy context from environment and secure storage.
 *
 * Returns an enabled context only when both the cloud base URL and
 * the assistant API key are present. Otherwise returns a disabled context.
 */
export async function resolveCloudProxyContext(): Promise<CloudProxyContext> {
  const cloudBaseUrl = getCloudBaseUrl().replace(/\/+$/, "");
  const assistantApiKey =
    (await getSecureKeyAsync(ASSISTANT_API_KEY_STORAGE_KEY)) ?? "";
  const enabled = !!cloudBaseUrl && !!assistantApiKey;
  _managedProxyEnabled = enabled;

  return { enabled, cloudBaseUrl, assistantApiKey };
}

/**
 * Check whether cloud proxy prerequisites are available.
 * Shorthand for checking that both platform URL and assistant API key exist.
 */
export async function hasCloudProxyPrereqs(): Promise<boolean> {
  return (await resolveCloudProxyContext()).enabled;
}

/**
 * Build the full cloud proxy base URL for a given provider.
 *
 * Combines the cloud base URL with the provider's deterministic proxy path.
 * Returns undefined if the provider is not managed or prerequisites are missing.
 */
export async function buildCloudBaseUrl(
  provider: string,
): Promise<string | undefined> {
  const meta = PLATFORM_PROVIDER_META[provider];
  if (!meta?.managed || !meta.proxyPath) {
    return undefined;
  }

  const ctx = await resolveCloudProxyContext();
  if (!ctx.enabled) {
    return undefined;
  }

  return `${ctx.cloudBaseUrl}${meta.proxyPath}`;
}

/**
 * Whether cloud fallback is enabled for a given provider.
 *
 * Returns true when the provider supports cloud proxy routing and
 * all prerequisites (platform URL + assistant API key) are satisfied.
 */
export async function managedFallbackEnabledFor(
  provider: string,
): Promise<boolean> {
  const meta = PLATFORM_PROVIDER_META[provider];
  if (!meta?.managed) {
    return false;
  }
  return await hasCloudProxyPrereqs();
}
