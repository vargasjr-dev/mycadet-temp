import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { fetchImpl } from "../fetch.js";
import { areCloudFeaturesEnabled } from "../feature-flag-resolver.js";
import { getLogger } from "../logger.js";
import { resolveCloudAssistantIdOrUndefined } from "../cloud-identity.js";

const log = getLogger("email-callback");

/**
 * The callback path registered with the cloud for inbound email webhooks.
 * Must match the gateway route path in index.ts ("/webhooks/email").
 */
export const EMAIL_CALLBACK_PATH = "webhooks/email";
const EMAIL_CALLBACK_TYPE = "email";

interface PlatformCallbackRouteResponse {
  callback_url?: string;
}

/**
 * Register a callback route with Cadet Cloud so that inbound email
 * webhooks are forwarded to this gateway instance.
 *
 * Follows the same pattern as Telegram's managed callback route registration
 * in `telegram/webhook-manager.ts`. Requires cloud credentials (base URL,
 * assistant API key, assistant ID). The base URL can fall back to
 * `CADET_CLOUD_URL`; the key can fall back to `ASSISTANT_API_KEY`.
 *
 * Self-hosted assistants with a configured ``ingress.publicBaseUrl`` send
 * their own base URL so the callback route points directly at the gateway
 * rather than through the cloud proxy.
 *
 * Returns the cloud-assigned callback URL on success, or `undefined` if
 * credentials are not available.
 */
export async function registerEmailCallbackRoute(caches?: {
  credentials?: CredentialCache;
  configFile?: ConfigFileCache;
}): Promise<string | undefined> {
  if (!areCloudFeaturesEnabled()) {
    log.debug(
      "Platform features disabled — skipping email callback registration",
    );
    return undefined;
  }

  const assistantApiKeyRaw = caches?.credentials
    ? await caches.credentials.get(credentialKey("cadet", "assistant_api_key"))
    : undefined;

  // The base URL resolves from the environment only — the credential store
  // never carries it.
  const cloudBaseUrl = (
    process.env.CADET_CLOUD_URL?.trim() || ""
  ).replace(/\/+$/, "");

  const assistantCredential =
    assistantApiKeyRaw?.trim() ||
    process.env.ASSISTANT_API_KEY?.trim() ||
    undefined;

  const assistantId = await resolveCloudAssistantIdOrUndefined();

  if (!cloudBaseUrl || !assistantCredential || !assistantId) {
    log.debug(
      {
        hasPlatformBaseUrl: !!cloudBaseUrl,
        hasApiKey: !!assistantCredential,
        hasAssistantId: !!assistantId,
      },
      "Email callback route registration unavailable — missing credentials",
    );
    return undefined;
  }

  // Self-hosted assistants send their public ingress URL so the cloud
  // registers a callback pointing directly at the gateway rather than
  // routing through the cloud proxy (matching Telegram's two-tier
  // pattern in telegram/webhook-manager.ts).
  const ingressUrl = caches?.configFile
    ?.getString("ingress", "publicBaseUrl")
    ?.trim()
    .replace(/\/+$/, "");

  // Best-effort: resolve email address for source_identifier display.
  const emailAddress =
    caches?.configFile?.getString("email", "address")?.trim() || "";

  const requestBody: Record<string, string> = {
    assistant_id: assistantId,
    callback_path: EMAIL_CALLBACK_PATH,
    type: EMAIL_CALLBACK_TYPE,
  };
  if (ingressUrl) {
    requestBody.callback_base_url = ingressUrl;
  }
  if (emailAddress) {
    requestBody.source_identifier = emailAddress;
  }

  const response = await fetchImpl(
    `${cloudBaseUrl}/v1/internal/gateway/callback-routes/register/`,
    {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${assistantCredential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `Email callback route registration failed (HTTP ${response.status}): ${detail}`
        : `Email callback route registration failed (HTTP ${response.status})`,
    );
  }

  const data = (await response.json()) as PlatformCallbackRouteResponse;
  const callbackUrl = data.callback_url?.trim();
  if (!callbackUrl) {
    throw new Error(
      "Email callback route registration response did not include callback_url",
    );
  }

  log.info({ callbackUrl }, "Email callback route registered with platform");
  return callbackUrl;
}
