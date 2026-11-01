import type {
  RemoteWebPairingChallengeResponse,
  RemoteWebPairingTokenApprovedResponse,
  RemoteWebPairingTokenPendingResponse,
  RemoteWebPairingTokenRequest,
} from "@mycadet/service-contracts/remote-web-pairing";

import { setSelfHostedConnection } from "@/lib/self-hosted/connection";

const PAIRING_TOKEN_PATH = "/v1/remote-web/pairing-token";
const PAIRING_CHALLENGE_PATH = "/v1/remote-web/pairing-challenge";
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/**
 * Credential fields {@link activateRemoteGatewaySession} consumes. Broader than
 * the pairing-token approved response because the same activation path also
 * handles the `/v1/guardian/refresh` rotation body, which serializes the two
 * instants as epoch-millisecond numbers — hence both accept `string | number`.
 */
interface RemoteGatewaySessionCredentials {
  accessToken: string;
  accessTokenExpiresAt: string | number;
  refreshAfter: string | number;
}

export type RemoteWebPairingTokenResult =
  | RemoteWebPairingTokenPendingResponse
  | RemoteWebPairingTokenApprovedResponse;

export class RemoteWebPairingError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "RemoteWebPairingError";
    this.status = status;
    this.code = code;
  }
}

function errorBodyCode(body: unknown): string | null {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" ? code : null;
}

export function remoteGatewayPublicPathPrefix(
  location = window.location,
): string {
  const match = /\/assistant(?:\/|$)/.exec(location.pathname);
  return match && match.index > 0
    ? location.pathname.slice(0, match.index).replace(/\/+$/, "")
    : "";
}

export function remoteGatewayApiPath(
  path: string,
  location = window.location,
): string {
  return `${remoteGatewayPublicPathPrefix(location)}${path}`;
}

/**
 * The server's public base URL: origin plus any path prefix the deployment is
 * served under (via {@link remoteGatewayPublicPathPrefix}). A prefix-served
 * assistant (pair page at `https://host/assistant-123/assistant/pair`) resolves
 * to `https://host/assistant-123`; consumers append their own route or API path
 * onto this base, so it must carry the prefix to reach the right assistant.
 */
export function remoteGatewayPublicBaseUrl(): string {
  return `${window.location.origin}${remoteGatewayPublicPathPrefix()}`;
}

function isApprovedPayload(
  value: unknown,
): value is RemoteWebPairingTokenApprovedResponse {
  const payload = value as Partial<RemoteWebPairingTokenApprovedResponse>;
  return (
    payload?.status === "approved" &&
    typeof payload.accessToken === "string" &&
    (typeof payload.accessTokenExpiresAt === "string" ||
      typeof payload.accessTokenExpiresAt === "number") &&
    (typeof payload.refreshAfter === "string" ||
      typeof payload.refreshAfter === "number")
  );
}

function isChallengePayload(
  value: unknown,
): value is RemoteWebPairingChallengeResponse {
  const payload = value as Partial<RemoteWebPairingChallengeResponse>;
  return (
    typeof payload?.deviceCode === "string" &&
    typeof payload.userCode === "string" &&
    typeof payload.verificationUri === "string" &&
    typeof payload.expiresAt === "string" &&
    typeof payload.expiresInSeconds === "number" &&
    typeof payload.intervalSeconds === "number"
  );
}

export function activateRemoteGatewaySession(
  session: RemoteGatewaySessionCredentials,
): void {
  // Cookie custody: the pairing response minted the HttpOnly cookies; JS holds nothing.
  void session;
  setSelfHostedConnection({
    url: `${window.location.origin}${remoteGatewayPublicPathPrefix()}`,
    token: null,
  });
}

export async function exchangeRemoteWebPairingToken(
  deviceCode: string,
  signal?: AbortSignal,
): Promise<RemoteWebPairingTokenResult> {
  const response = await fetch(remoteGatewayApiPath(PAIRING_TOKEN_PATH), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode } satisfies RemoteWebPairingTokenRequest),
    signal,
  });
  // A non-JSON body (e.g. an HTML error page) resolves to null and falls
  // through to the status / shape checks below.
  const body = (await response.json().catch(() => null)) as unknown;

  if (response.status === 202) {
    const pending = (body ??
      {}) as Partial<RemoteWebPairingTokenPendingResponse>;
    return {
      status: "pending",
      expiresAt: typeof pending.expiresAt === "string" ? pending.expiresAt : "",
      intervalSeconds:
        typeof pending.intervalSeconds === "number" &&
        pending.intervalSeconds > 0
          ? pending.intervalSeconds
          : DEFAULT_POLL_INTERVAL_SECONDS,
    };
  }

  if (!response.ok) {
    throw new RemoteWebPairingError(
      response.status,
      `Pairing token exchange failed: ${response.status}`,
      errorBodyCode(body),
    );
  }

  if (!isApprovedPayload(body)) {
    throw new RemoteWebPairingError(
      502,
      "Pairing token exchange returned an invalid response",
    );
  }

  return body;
}

export async function createRemoteWebPairingChallenge(
  signal?: AbortSignal,
): Promise<RemoteWebPairingChallengeResponse> {
  const response = await fetch(remoteGatewayApiPath(PAIRING_CHALLENGE_PATH), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal,
  });
  const body = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new RemoteWebPairingError(
      response.status,
      `Pairing challenge creation failed: ${response.status}`,
    );
  }

  if (!isChallengePayload(body)) {
    throw new RemoteWebPairingError(
      502,
      "Pairing challenge creation returned an invalid response",
    );
  }

  return body;
}
