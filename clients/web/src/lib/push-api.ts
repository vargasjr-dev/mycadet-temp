/**
 * Native push registration dials, aimed at the assistant's gateway paths —
 * the gateway is the plane that eventually hits the assistant, which will
 * own its own push provider configuration the way it owns inference. The
 * generated cloud sdk used to own these; the shapes here are the panel's
 * own, parsed nothing — the answers are registration rows the callers
 * never read, so the module reports success/failure and nothing else.
 */

import { dial, type DialOutcome } from "@/lib/dial";

/** The push surface's contract: `{ error: null }` or the failure. */
function outcomeError(outcome: DialOutcome): { error: Error | null } {
  if (outcome.networkError) {
    return {
      error:
        outcome.networkError instanceof Error
          ? outcome.networkError
          : new Error(String(outcome.networkError)),
    };
  }
  if (!outcome.response?.ok) {
    return {
      error: new Error(`The push dial failed (${outcome.response?.status})`),
    };
  }
  return { error: null };
}

/** APNs entitlement environment a token was minted under. */
export type PushApnsEnvironment = "production" | "development";

/** The generated Android upsert body, carried locally. */
export interface AndroidDevicePushTokenUpsert {
  token: string;
  platform: "android";
  bundle_id: string;
  /**
   * What the shell registering this token can render. Known values:
   * native-notification-render. An unknown value is dropped and the rest
   * of the registration succeeds, so a shell may advertise a capability
   * this server does not know yet. Omitting resets the stored list to [].
   */
  capabilities?: string[];
}

/** The generated iOS upsert body, carried locally. */
export interface IosDevicePushTokenUpsert {
  token: string;
  platform: "ios";
  bundle_id: string;
  apns_environment: PushApnsEnvironment;
}

export type DevicePushTokenUpsert =
  | IosDevicePushTokenUpsert
  | AndroidDevicePushTokenUpsert;

/** The Live Activity upsert body, carried locally. */
export interface LiveActivityTokenUpsert {
  token: string;
  bundle_id: string;
  apns_environment: PushApnsEnvironment;
  conversation_id: string;
  /** Must cover every phase the activity can be pushed into. */
  labels?: unknown;
  accent_hex?: string;
  muted?: boolean;
}

const scoped = (assistantId: string, tail: string) =>
  `/v1/assistants/${encodeURIComponent(assistantId)}/${tail}`;

/**
 * Upsert a freshly-minted device token to the assistant's cloud record.
 * Idempotent; the cloud fans dispatches out to every registered token.
 */
export async function upsertDevicePushToken(
  assistantId: string,
  body: DevicePushTokenUpsert,
): Promise<{ error: Error | null }> {
  return outcomeError(
    await dial(scoped(assistantId, "push-tokens/"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Remove a device token — the logout path, which must run while the
 * session cookie is still present.
 */
export async function deleteDevicePushToken(
  assistantId: string,
  deviceToken: string,
  bundleId: string,
): Promise<{ error: Error | null }> {
  return outcomeError(
    await dial(
      scoped(
        assistantId,
        `push-tokens/${encodeURIComponent(deviceToken)}/?bundle_id=${encodeURIComponent(bundleId)}`,
      ),
      { method: "DELETE" },
    ),
  );
}

/**
 * Remove a Live Activity's update token — the session-end path, so a
 * finished activity stops being pushed.
 */
export async function deleteLiveActivityToken(
  assistantId: string,
  deviceToken: string,
): Promise<{ error: Error | null }> {
  return outcomeError(
    await dial(
      scoped(
        assistantId,
        `live-activity/tokens/${encodeURIComponent(deviceToken)}/`,
      ),
      { method: "DELETE" },
    ),
  );
}

/**
 * Register one ActivityKit Live Activity's update token, so its phases
 * can be pushed while the session is backgrounded.
 */
export async function upsertLiveActivityToken(
  assistantId: string,
  body: LiveActivityTokenUpsert,
): Promise<{ error: Error | null }> {
  return outcomeError(
    await dial(scoped(assistantId, "live-activity/tokens/"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
