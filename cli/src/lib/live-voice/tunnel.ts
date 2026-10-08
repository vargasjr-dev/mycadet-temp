/**
 * The cloud leg of a live-voice session: minting a tunnel WS token and building
 * the URL it opens.
 *
 * A platform-hosted assistant is not reachable the way a local one is. Its
 * gateway sits behind tunnel, tunnel performs no user authentication of its own,
 * and the gateway upstream accepts only an actor edge JWT or a tunnel
 * attestation. The CLI holds neither for a cloud instance: what it has is a
 * platform session token, which is the wrong credential for the socket but the
 * right one for the platform.
 *
 * So the connection is made in two hops, the same two the web voice room makes
 * (`clients/web/src/domains/chat/voice/live-voice/connection.ts`):
 *
 *  1. POST the platform for a short-lived, org+assistant-scoped WS token.
 *  2. Open `wss://<tunnel>/<assistantId>/v1/live-voice?token=<wsToken>`.
 *
 * tunnel consumes the token on the upgrade and injects the authenticated user
 * and org downstream as `X-Tunnel-*` headers alongside its bridge proof. The
 * gateway reads that attestation rather than the query param, and pins it to
 * the assistant's bound guardian (`requireManagedGuardian`). The token is
 * therefore an admission ticket for one upgrade, not a session credential.
 *
 * Two properties of that ticket shape this module's API. It lives for
 * `LIVE_VOICE_WS_TOKEN_TTL` (60 seconds) and it is **single-use**: the
 * validator consumes it atomically, so the same token cannot open a second
 * socket. Minting is consequently tied to connecting, and a reconnect has to
 * mint again rather than reuse what resolution returned.
 */

import { tunnelHostForPlatformHost } from "@mycadet/service-contracts/ingress";

import { authHeaders } from "../platform-client.js";

/** Production tunnel, when the platform host implies nothing more specific. */
const DEFAULT_TUNNEL_HOST = "tunnel.mycadet.ai";

/** Give up on the mint rather than hang the session behind a stalled platform. */
const MINT_TIMEOUT_MS = 10_000;

export class TunnelWsTokenError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TunnelWsTokenError";
    this.status = status;
  }
}

/**
 * The tunnel host serving a given platform base URL.
 *
 * `CADET_TUNNEL_HOST` wins when set, which is how a local `vel up` stack is
 * reached: its tunnel is a loopback port that no naming convention predicts.
 * Otherwise the deployment convention maps the platform host onto its sibling
 * (`cloud.mycadet.ai` to `tunnel.mycadet.ai`, `dev-cloud.mycadet.ai` to
 * `tunnel-dev.mycadet.ai`). A host outside that convention, including localhost,
 * yields the production default, because guessing a tunnel for it would be
 * worse than dialing the one host that certainly exists.
 */
export function tunnelHostForPlatformUrl(platformUrl: string): string {
  const override = process.env.CADET_TUNNEL_HOST?.trim();
  if (override) {
    return override;
  }
  try {
    return (
      tunnelHostForPlatformHost(new URL(platformUrl).host) ??
      DEFAULT_TUNNEL_HOST
    );
  } catch {
    return DEFAULT_TUNNEL_HOST;
  }
}

/**
 * `ws` for a loopback tunnel, `wss` for everything else.
 *
 * The local `vel up` tunnel is plain HTTP on a loopback port, which a `wss` dial
 * cannot reach. Mirrors `getTunnelWsScheme` in the web client so the two ends of
 * the transport cannot disagree about which scheme a host takes.
 */
export function tunnelWsScheme(host: string): "ws" | "wss" {
  let hostname: string;
  try {
    ({ hostname } = new URL(`http://${host}`));
  } catch {
    return "wss";
  }
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
    ? "ws"
    : "wss";
}

/**
 * Build the tunnel live-voice URL.
 *
 * The `/<assistantId>` prefix is what selects the tunnel: tunnel strips it to
 * recover the upstream path, and matches that path against its allowlist and
 * against the scope recorded for the token. The token rides as `?token=`
 * because a WebSocket upgrade from a non-browser client still cannot carry a
 * credential anywhere tunnel reads except the query string.
 */
export function buildTunnelLiveVoiceUrl(args: {
  platformUrl: string;
  assistantId: string;
  token: string;
}): string {
  const host = tunnelHostForPlatformUrl(args.platformUrl);
  const url = new URL(
    `${tunnelWsScheme(host)}://${host}/${args.assistantId}/v1/live-voice`,
  );
  url.searchParams.set("token", args.token);
  return url.toString();
}

interface LiveVoiceTokenResponse {
  token?: unknown;
  expiresAt?: unknown;
}

/**
 * Mint a single-use tunnel WS token for one assistant.
 *
 * Authenticates with the CLI's stored platform session token. The mint
 * endpoint pins its authenticators to the user-session ones
 * (`SessionAuthentication` and `XSessionTokenAuthentication`) and deliberately
 * excludes API-key auth, so `X-Session-Token` is the CLI's way in and a
 * `vak_` key is not: a caller holding only an API key cannot mint here, by
 * design on the platform's side.
 *
 * Throws {@link TunnelWsTokenError} carrying the HTTP status, so the caller can
 * tell "sign in again" (401) from "not your assistant" (403) from a platform
 * that is simply down.
 */
export async function mintTunnelWsToken(args: {
  platformUrl: string;
  assistantId: string;
  sessionToken: string;
}): Promise<string> {
  const url = `${args.platformUrl.replace(/\/+$/, "")}/v1/auth/live-voice-token/`;
  // `authHeaders` resolves `Cadet-Organization-Id`, which the endpoint needs
  // to scope the token, and which is cached per token so a session does not
  // pay for an extra round trip.
  const headers = await authHeaders(args.sessionToken, args.platformUrl);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ assistantId: args.assistantId }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new TunnelWsTokenError(
      0,
      `Could not reach Cadet Cloud to authorize the voice session: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!response.ok) {
    throw new TunnelWsTokenError(
      response.status,
      describeMintFailure(response.status),
    );
  }

  const body = (await response.json().catch(() => ({}))) as
    | LiveVoiceTokenResponse
    | undefined;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) {
    throw new TunnelWsTokenError(
      response.status,
      "Cadet Cloud returned no voice session token.",
    );
  }
  return token;
}

/** Turn a mint rejection into something the user can act on. */
function describeMintFailure(status: number): string {
  if (status === 401) {
    return "Not signed in to Cadet Cloud. Run 'cadet login' and try again.";
  }
  if (status === 403) {
    return "This account cannot open a voice session on that assistant. Check that it belongs to the organization you are signed in to.";
  }
  if (status === 404) {
    return "Cadet Cloud does not offer voice session tokens. It may be running an older release.";
  }
  return `Cadet Cloud refused to authorize the voice session (HTTP ${status}).`;
}
