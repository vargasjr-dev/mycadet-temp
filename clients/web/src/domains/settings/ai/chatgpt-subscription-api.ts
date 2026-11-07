/**
 * API layer for connecting a ChatGPT subscription.
 *
 * `resolveChatgptConnection` is shared by both sign-in paths, which finish the
 * same way once the credential is stored.
 */

import { inferenceProviderconnectionsGet } from "@/generated/daemon/sdk.gen";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
/**
 * Credential the daemon stores the subscription's access token under, and
 * stamps the `chatgpt-subscription` connection with.
 */
export const CHATGPT_ACCESS_TOKEN_CREDENTIAL =
  "credential/chatgpt/access_token";

/**
 * The daemon serving this assistant predates the device-code routes, so the
 * redirect-and-paste sign-in is the only path it offers.
 */
export class DeviceAuthUnsupportedError extends Error {
  constructor() {
    super("This assistant does not support device-code sign-in.");
    this.name = "DeviceAuthUnsupportedError";
  }
}

/**
 * The subscription row the daemon just wrote, for the parent to persist.
 *
 * The listing is unfiltered: the row is found by name, and its `provider`
 * column differs across daemon versions ("chatgpt" on current daemons,
 * "openai" on older ones), so a provider-filtered list can miss it. A listing
 * that fails or does not carry the row yet falls back to a synthesized row
 * rather than reporting a failure: the credential is already stored by the
 * time this runs, so the sign-in did succeed.
 */
export async function resolveChatgptConnection(
  assistantId: string,
): Promise<ProviderConnection> {
  try {
    const { data } = await inferenceProviderconnectionsGet({
      path: { assistant_id: assistantId },
      throwOnError: true,
    });
    const connection = data.connections.find(
      (c) => c.name === "chatgpt-subscription" || c.name === "openai-chatgpt",
    );
    if (connection) {
      return connection;
    }
  } catch {
    // Fall through to the synthesized row.
  }
  const now = Date.now();
  return {
    name: "chatgpt-subscription",
    provider: "chatgpt",
    auth: {
      type: "oauth_subscription",
      credential: CHATGPT_ACCESS_TOKEN_CREDENTIAL,
    },
    label: "ChatGPT Subscription",
    createdAt: now,
    updatedAt: now,
    baseUrl: null,
    models: null,
    isManaged: false,
  };
}
