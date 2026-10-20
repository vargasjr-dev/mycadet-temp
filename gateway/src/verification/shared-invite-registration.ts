/**
 * Registers a `cadet-shared` invite with the cloud, which routes the
 * invitee's redemption back to this assistant. The cloud receives only the
 * link-token hash and the invite's expiry, never the token itself.
 */

import { hashInviteToken } from "@mycadet/gateway-client";

import { credentialKey } from "../credential-key.js";
import { readCredentialResult } from "../credential-reader.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("shared-invite-registration");

const SHARED_INVITE_CHANNEL = "cadet-shared";
const SHARED_INVITE_REGISTRATION_PATH = "/v1/internal/shared-invites/";

const REGISTRATION_TIMEOUT_MS = 10_000;

export type SharedInviteRegistrationResult =
  /** Registered, or nothing to register for this invite or gateway. */
  | { status: "registered" | "skipped" }
  /** The cloud already holds this hash. */
  | { status: "duplicate" }
  /** The cloud refused another outstanding invite. */
  | { status: "limit_reached" }
  /** The credential store could not be read. */
  | { status: "unavailable" }
  /** Any other refusal or transport failure. */
  | { status: "failed" };

/**
 * Store value when present, else the environment fallback. `unreachable` is
 * set only when the store could not be read and no fallback exists.
 */
async function readCloudCredential(
  field: "assistant_api_key",
  envName: string,
): Promise<{ value: string; unreachable: boolean }> {
  const stored = await readCredentialResult(credentialKey("cadet", field));
  const value = stored.value?.trim() || process.env[envName]?.trim() || "";
  return { value, unreachable: !value && stored.unreachable };
}

/**
 * Register the invite's link-token hash and expiry with the cloud.
 *
 * Skipped for any channel other than `cadet-shared`, when platform features
 * are disabled, and when no cloud credentials are configured.
 */
export async function registerSharedInvite(params: {
  sourceChannel: string;
  rawToken: string;
  expiresAt: number;
}): Promise<SharedInviteRegistrationResult> {
  if (params.sourceChannel !== SHARED_INVITE_CHANNEL) {
    return { status: "skipped" };
  }

  const [cloudBaseUrl, apiKey] = await Promise.all([
    Promise.resolve(
      (process.env.CADET_CLOUD_URL?.trim() || "").replace(/\/+$/, ""),
    ),
    readCloudCredential("assistant_api_key", "ASSISTANT_API_KEY"),
  ]);
  if (apiKey.unreachable) {
    log.warn("Shared invite registration: credential store unreachable");
    return { status: "unavailable" };
  }
  if (!cloudBaseUrl || !apiKey.value) {
    log.debug(
      {
        hasPlatformBaseUrl: !!cloudBaseUrl,
        hasApiKey: !!apiKey.value,
      },
      "Shared invite registration skipped: no cloud credentials",
    );
    return { status: "skipped" };
  }

  const url = `${cloudBaseUrl}${SHARED_INVITE_REGISTRATION_PATH}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${apiKey.value}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code_hash: hashInviteToken(params.rawToken),
        expires_at: Math.floor(params.expiresAt),
      }),
      signal: AbortSignal.timeout(REGISTRATION_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn({ err }, "Shared invite registration request failed");
    return { status: "failed" };
  }

  if (response.ok) {
    return { status: "registered" };
  }
  log.warn(
    { status: response.status },
    "Shared invite registration refused by the cloud",
  );
  if (response.status === 409) {
    return { status: "duplicate" };
  }
  if (response.status === 429) {
    return { status: "limit_reached" };
  }
  return { status: "failed" };
}
