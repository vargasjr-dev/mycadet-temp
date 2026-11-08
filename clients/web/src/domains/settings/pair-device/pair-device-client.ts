/**
 * Browser side of the `cadet pair` flow. In desktop/local mode the SPA drives
 * the two loopback-only routes the CLI uses through the scoped same-origin
 * data plane (`/v1/assistants/<assistantId>/remote-web/...`; the host routes
 * by the id in the path):
 *   1. `POST /v1/remote-web/pairing-challenge` — mint a device-code challenge.
 *   2. `POST /v1/remote-web/pairing-verification` — approve it with the user
 *      code. Running on the host IS the authorization, so the scan alone
 *      completes pairing.
 *
 * Approving requests minted elsewhere (e.g. the public `/assistant/pair`
 * page) is the host operator's job through the gateway CLI:
 * `gateway pairing list`, then `gateway pairing approve|deny <requestId>`.
 * Loopback HTTP is not an authorization check the gateway should trust, so
 * those routes are gone.
 */

import type {
  RemoteWebPairingChallengeResponse,
  RemoteWebPairingVerificationRequest,
} from "@mycadet/service-contracts/remote-web-pairing";

import { t } from "@/i18n";
import { getResolvedAssistant } from "@/stores/resolved-assistant-store";
import { isCancellationError } from "@mycadet/design-library/utils/is-cancellation-error";

import { buildRemoteWebPairingUrl } from "@mycadet/service-contracts/remote-web-pairing";

const PAIRING_CHALLENGE_PATH = "/pairing-challenge";
const PAIRING_VERIFICATION_PATH = "/pairing-verification";

/**
 * Guidance appended when the host rejects the mint. The routes themselves only
 * require loopback, but a scan can only complete when the public URL actually
 * fronts this assistant, the usual reason pairing doesn't work end to end.
 * A function rather than a module constant so the catalog is read at request
 * time, after i18next is initialized and in the active locale.
 */
export function pairingConnectivityHint(): string {
  return t("settings:pairDeviceClient.connectivityHint");
}

/** A pairing request that failed, carrying an optional actionable hint. */
export class PairDeviceError extends Error {
  readonly hint?: string;
  /** HTTP status of the rejecting response; unset for network failures. */
  readonly status?: number;
  /** Machine-readable error code from the response body, when present. */
  readonly code?: string;

  constructor(
    message: string,
    options: { hint?: string; status?: number; code?: string } = {},
  ) {
    super(message);
    this.name = "PairDeviceError";
    this.hint = options.hint;
    this.status = options.status;
    this.code = options.code;
  }
}

/** Error code the deny route returns when the request was approved first. */
export const ALREADY_APPROVED_ERROR_CODE = "ALREADY_APPROVED";

export interface DevicePairing {
  /** The scannable https pair URL (verification URI + `#device_code=…`). */
  pairUrl: string;
  /** ISO-8601 instant the pairing expires (single-use). */
  expiresAt: string;
}

/** What the "Pair a device" card needs about the assistant it pairs. */
export interface PairDeviceTarget {
  /** Scoped same-origin base for the assistant's remote-web routes. */
  base: string;
  /** The paired assistant's display name, or `null` when it has none. */
  assistantName: string | null;
}

/**
 * Resolve the selected assistant's scoped remote-web base, or `null` when
 * there is no assistant to pair. Device pairing works for every assistant
 * entry: the scoped data plane is plain same-origin `/v1`, so any entry the
 * bundle resolved can host a pairing — a `null` here is only the
 * not-yet-resolved pre-projection window, doubling as the section's
 * visibility gate.
 */
export function resolvePairDeviceTarget(): PairDeviceTarget | null {
  const assistant = getResolvedAssistant();
  // The shell's empty id = the not-yet-resolved pre-projection window —
  // exactly the null the docblock describes.
  if (assistant.assistantId === "") {
    return null;
  }
  return {
    base: `${window.location.origin}/v1/assistants/${encodeURIComponent(
      assistant.assistantId,
    )}/remote-web`,
    assistantName: assistant.name?.trim() || null,
  };
}

function serverErrorMessage(payload: unknown): string | null {
  const message = (payload as { error?: { message?: unknown } } | null)?.error
    ?.message;
  return typeof message === "string" && message.trim() ? message : null;
}

function serverErrorCode(payload: unknown): string | undefined {
  const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" && code ? code : undefined;
}

async function pairingRouteRequest<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  rejectionHint?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (err) {
    if (isCancellationError(err)) {
      throw err;
    }
    throw new PairDeviceError(t("settings:pairDeviceClient.networkError"));
  }

  // A non-JSON body (e.g. an HTML error page) resolves to null and falls
  // through to the status / shape checks below.
  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new PairDeviceError(
      serverErrorMessage(payload) ??
        t("settings:pairDeviceClient.httpError", { status: response.status }),
      {
        hint: rejectionHint,
        status: response.status,
        code: serverErrorCode(payload),
      },
    );
  }

  if (payload === null || typeof payload !== "object") {
    throw new PairDeviceError(
      t("settings:pairDeviceClient.unexpectedResponse"),
    );
  }
  return payload as T;
}

function postPairingRoute<T>(
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  rejectionHint?: string,
): Promise<T> {
  return pairingRouteRequest<T>(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
    rejectionHint,
  );
}

/**
 * Mint and auto-approve a device pairing against the host's loopback gateway,
 * returning the scannable pair URL and its expiry. Throws {@link PairDeviceError}
 * on rejection or an unreachable gateway; rethrows an `AbortError` when the
 * caller cancels.
 */
export async function mintDevicePairing(args: {
  base: string;
  signal?: AbortSignal;
}): Promise<DevicePairing> {
  const { base, signal } = args;

  const challenge = await postPairingRoute<RemoteWebPairingChallengeResponse>(
    `${base}${PAIRING_CHALLENGE_PATH}`,
    {},
    signal,
    pairingConnectivityHint(),
  );

  try {
    await postPairingRoute(
      `${base}${PAIRING_VERIFICATION_PATH}`,
      {
        userCode: challenge.userCode,
      } satisfies RemoteWebPairingVerificationRequest,
      signal,
      pairingConnectivityHint(),
    );
  } catch (err) {
    // A failed verification leaves the minted challenge pending until its
    // TTL; the store's own expiry cleanup reaps it.
    throw err;
  }

  return {
    pairUrl: buildRemoteWebPairingUrl(challenge),
    expiresAt: challenge.expiresAt,
  };
}
