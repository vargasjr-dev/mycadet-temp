/**
 * Live-voice WebSocket connection + transport routing.
 *
 * Live voice picks its transport by deployment kind via
 * {@link resolveLiveVoiceWsUrl}:
 *
 * - **Cloud** — streams audio to the cloud environment's tunnel (prod
 *   `tunnel.mycadet.ai`, staging `tunnel-staging.mycadet.ai`, …), which is
 *   cross-origin from the `cloud.mycadet.ai` SPA. A same-origin cookie WS
 *   upgrade is NOT viable: tunnel does no user auth, and the channel gateway
 *   only accepts a local actor edge JWT. So the browser first mints a
 *   short-lived, org+assistant-scoped WS token from the cloud and passes it
 *   to tunnel as a `?token=` query param.
 * - **Self-hosted / local** — when {@link getSelfHostedIngressUrl} returns the
 *   user's gateway ingress, the browser connects directly to that gateway's
 *   `/v1/live-voice`, authenticated with the cloud actor edge JWT
 *   ({@link getSelfHostedActorToken}) in `?token=`. tunnel is the cloud ingress
 *   only, so there is no token-exchange on this path — it mirrors how the
 *   self-hosted HeyAPI interceptor already routes runtime calls to the gateway.
 *
 * ---------------------------------------------------------------------------
 * Mint-endpoint contract (the backend plan must match this verbatim)
 * ---------------------------------------------------------------------------
 *
 *   POST /v1/auth/live-voice-token/
 *     Auth:     Django SessionAuthentication — session cookie + CSRF
 *               (`X-CSRFToken`) + `Cadet-Organization-Id`, all attached
 *               automatically by the cloud HeyAPI client interceptor.
 *               Do NOT hand-roll an `Authorization` header.
 *     Request:  { assistantId: string }
 *     Response: { token: string; expiresAt: string }   // expiresAt is ISO-8601
 *
 * The endpoint scopes the minted token to the caller's active org and the
 * requested assistant; tunnel validates it on the WS upgrade.
 *
 * We call the generated platform SDK function `authLiveVoiceTokenCreate`, which
 * routes through the cloud `client` — that interceptor attaches the session
 * cookie + CSRF + `Cadet-Organization-Id`.
 *
 * This module is the route-agnostic gateway WS transport shared by live voice,
 * watch (`domains/chat/watch`), and the assistant desktop (`domains/chat/desktop`).
 */

import { tunnelHostForPlatformHost } from "@mycadet/service-contracts/ingress";

import { authLiveVoiceTokenCreate } from "@/generated/api/sdk.gen";
import type { LiveVoiceTokenResponse } from "@/generated/api/types.gen";
import { getCloudRuntimeUrl } from "@/lib/cloud-runtime-url";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
} from "@/lib/self-hosted/connection";
import { assertHasResponse } from "@/utils/api-errors";

/**
 * Production tunnel host (no scheme). Fallback when neither the
 * `VITE_TUNNEL_HOST` override nor the cloud-host derivation applies.
 */
const DEFAULT_TUNNEL_HOST = "tunnel.mycadet.ai";

const LIVE_VOICE_ROUTE = "/v1/live-voice";

export class TunnelWsTokenError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TunnelWsTokenError";
    this.status = status;
  }
}

/**
 * Type guard for the mint endpoint's wire shape. The SDK function is typed but
 * the body is unverified on the wire — narrow defensively rather than trusting
 * the generic.
 */
function isTunnelWsToken(value: unknown): value is LiveVoiceTokenResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  return typeof v.token === "string" && typeof v.expiresAt === "string";
}

/**
 * Mint a short-lived, user+org+assistant-scoped tunnel WS token.
 *
 * POSTs `/v1/auth/live-voice-token/` through the credentialed platform client
 * so the session cookie, CSRF token, and `Cadet-Organization-Id` ride along
 * automatically (see the module doc comment for the contract).
 *
 * Named for tunnel rather than for live voice because the token is not a
 * live-voice token in substance: the cloud stores it as an opaque random
 * string against a scope of `{user_id, organization_id, assistant_id}` and
 * nothing else (`django/app/auth/live_voice_token.py`). There is no route in
 * the scope, so the same token authorizes any tunnel WebSocket route that
 * requires per-user validation, and a second one now does
 * (`/v1/watch/stream`). Only the endpoint's URL still carries the original
 * name, which is a wire compatibility detail rather than a claim about what
 * the token is good for.
 */
export async function mintTunnelWsToken(
  assistantId: string,
): Promise<LiveVoiceTokenResponse> {
  const { data, error, response } = await authLiveVoiceTokenCreate({
    body: { assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to mint tunnel WS token");
  if (!response.ok) {
    throw new TunnelWsTokenError(
      response.status,
      `Tunnel WS token request failed (HTTP ${response.status})`,
    );
  }
  if (!isTunnelWsToken(data)) {
    throw new TunnelWsTokenError(0, "Tunnel WS token response was malformed");
  }
  return data;
}

/**
 * Resolve the tunnel host (no scheme). An explicit `VITE_TUNNEL_HOST` always
 * wins (local `vel up` tunnel); otherwise derive it from the cloud runtime
 * URL so one renderer build follows whichever platform environment it is
 * connected to — the Electron web bundle is built without `VITE_TUNNEL_HOST`,
 * and baking the prod default would send a staging assistant's token to prod
 * tunnel, which rejects it on the WS upgrade.
 */
function getTunnelHost(): string {
  if (import.meta.env.VITE_TUNNEL_HOST) {
    return import.meta.env.VITE_TUNNEL_HOST;
  }
  try {
    const derived = tunnelHostForPlatformHost(
      new URL(getCloudRuntimeUrl()).hostname,
    );
    if (derived) {
      return derived;
    }
  } catch {
    // Unparseable platform URL — fall through to the prod default.
  }
  return DEFAULT_TUNNEL_HOST;
}

/**
 * Pick the WebSocket scheme for a tunnel host. Production tunnel is TLS (`wss`),
 * but the local `vel up` tunnel is plain HTTP on a loopback port
 * (`localhost:8501`), which a `wss` dial can't reach. Detect a loopback host and
 * downgrade to `ws` so local-dev (incl. cloud assistants tunnelled through the
 * local tunnel) works without TLS. Everything else stays `wss`.
 *
 * Exported for direct unit testing (the env-driven host resolution is separate).
 */
export function getTunnelWsScheme(host: string): "ws" | "wss" {
  let hostname: string;
  try {
    ({ hostname } = new URL(`http://${host}`));
  } catch {
    return "wss";
  }
  const loopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1";
  return loopback ? "ws" : "wss";
}

export interface BuildTunnelWsUrlArgs {
  assistantId: string;
  /** Gateway route to open, e.g. `/v1/live-voice` or `/v1/watch/stream`. */
  routePath: string;
  /** Short-lived token from {@link mintTunnelWsToken}. */
  token: string;
  /** Extra query params to append after `token` (e.g. `conversationId`). */
  params?: Record<string, string>;
}

/**
 * Build a tunnel WebSocket URL for the cloud path:
 *
 *   wss://<tunnelHost>/<assistantId><routePath>?token=<token>[&…]
 *
 * The cloud counterpart of {@link buildSelfHostedGatewayWsUrl}, and shared by
 * every tunnel WS the browser opens for the same reason that one is shared: the
 * transport rules belong in one place rather than once per route.
 *
 * - **The `/<assistantId>` prefix selects the tunnel.** tunnel strips it to
 *   recover the upstream path, which is what it matches its allowlist and its
 *   per-user token validation against.
 * - **The scheme** is `wss` for the real tunnel host and `ws` when
 *   `VITE_TUNNEL_HOST` points at a loopback (local `vel up` tunnel) — see
 *   {@link getTunnelWsScheme}.
 * - **The token is a minted tunnel token**, not the actor edge JWT the
 *   self-hosted builder uses. tunnel consumes it on the upgrade and injects the
 *   authenticated user/org downstream; the gateway reads that attestation
 *   rather than the query param.
 * - **Extra params are forwarded upstream** by tunnel, which is how the gateway
 *   sees `conversationId` on live voice and `mimeType`/`sampleRate` on watch.
 *
 * Values are URL-encoded by `URLSearchParams`.
 */
export function buildTunnelWsUrl({
  assistantId,
  routePath,
  token,
  params,
}: BuildTunnelWsUrlArgs): string {
  const host = getTunnelHost();
  const scheme = getTunnelWsScheme(host);
  const url = new URL(`${scheme}://${host}/${assistantId}${routePath}`);
  url.searchParams.set("token", token);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Local gateway proxy path (`/assistant/__gateway/<port>`) as produced by
 * `gatewayProxyUrl` in local-mode. HTTP gateway traffic rides this same-origin
 * proxy, but a live-voice WebSocket cannot: both hosts that serve the proxy —
 * the Vite dev-server middleware and the Electron `app://` protocol forward —
 * proxy HTTP only and drop the WS upgrade, so a WS dialled at the proxy path
 * never reaches the gateway. When the ingress is this proxy path we therefore
 * bypass it and dial the loopback gateway port directly (the `ws://127.0.0.1:*`
 * shape the desktop CSP already allowlists).
 */
const LOCAL_GATEWAY_PROXY_PATH = /^\/assistant\/__gateway\/(\d+)\/?$/;

/**
 * Paired gateway proxy path (`/assistant/__gateway-paired/<assistantId>`) as
 * produced by `pairedGatewayProxyUrl` in local-mode. Like the local proxy, the
 * hosts serving it forward HTTP only and drop WS upgrades; unlike the local
 * proxy there is no loopback port to bypass to (the real gateway lives on
 * another machine), so no WebSocket transport exists for a paired assistant.
 */
const PAIRED_GATEWAY_PROXY_PATH = /^\/assistant\/__gateway-paired\//;

/**
 * Whether a self-hosted ingress URL rides the paired gateway proxy, which
 * cannot carry a WebSocket upgrade. Voice entry points use this to degrade
 * cleanly instead of dialling an unusable socket.
 */
export function isPairedGatewayIngress(ingressUrl: string): boolean {
  try {
    return PAIRED_GATEWAY_PROXY_PATH.test(new URL(ingressUrl).pathname);
  } catch {
    return false;
  }
}

/**
 * Thrown when a voice WebSocket URL is requested for a paired-assistant
 * ingress. The message is user-facing: live-voice's connect failure path
 * surfaces `Error.message` as the displayed reason.
 */
export class PairedVoiceUnavailableError extends Error {
  constructor() {
    super("Voice isn't available for paired assistants yet.");
    this.name = "PairedVoiceUnavailableError";
  }
}

export interface BuildSelfHostedGatewayWsUrlArgs {
  /**
   * The user's gateway ingress URL (e.g. `https://x.ngrok-free.app` or the local
   * `/assistant/__gateway/<port>` proxy path), from {@link getSelfHostedIngressUrl}.
   */
  ingressUrl: string;
  /** Gateway route to open, e.g. `/v1/live-voice` or `/v1/stt/stream`. */
  routePath: string;
  /** Platform actor edge JWT from {@link getSelfHostedActorToken}. */
  token: string;
  /** Extra query params to append after `token` (e.g. `conversationId`). */
  params?: Record<string, string>;
}

/**
 * Build a self-hosted gateway WebSocket URL. Shared by every gateway WS the
 * browser opens (`/v1/live-voice`, `/v1/stt/stream`) so the transport rules stay
 * in one place:
 *
 * - **Scheme follows the ingress:** `https`→`wss`, `http`→`ws`, so a plain-HTTP
 *   local gateway is reachable over `ws`.
 * - **The token is the actor edge JWT**, not a minted tunnel token. It rides in
 *   `?token=` because the browser WebSocket API can't set an `Authorization`
 *   header; the gateway's non-managed auth reads it there.
 * - **Local `/assistant/__gateway/<port>` proxy path → direct loopback dial**
 *   (`ws://127.0.0.1:<port>{routePath}`), since that HTTP-only proxy can't carry
 *   the WS upgrade — see {@link LOCAL_GATEWAY_PROXY_PATH}.
 * - **Paired `/assistant/__gateway-paired/<id>` proxy path → throws
 *   {@link PairedVoiceUnavailableError}**: the proxy is HTTP-only and there is
 *   no direct dial to fall back to, so no usable WS URL exists (see
 *   {@link PAIRED_GATEWAY_PROXY_PATH}).
 * - **Remote ingress** (e.g. an ngrok `wss://` URL) keeps its host and path
 *   prefix, with `routePath` appended. Any query/hash on the ingress is dropped.
 */
export function buildSelfHostedGatewayWsUrl({
  ingressUrl,
  routePath,
  token,
  params,
}: BuildSelfHostedGatewayWsUrlArgs): string {
  const ingress = new URL(ingressUrl);
  if (PAIRED_GATEWAY_PROXY_PATH.test(ingress.pathname)) {
    throw new PairedVoiceUnavailableError();
  }
  const localProxy = ingress.pathname.match(LOCAL_GATEWAY_PROXY_PATH);

  let target: URL;
  if (localProxy) {
    target = new URL(`ws://127.0.0.1:${localProxy[1]}${routePath}`);
  } else {
    ingress.protocol = ingress.protocol === "http:" ? "ws:" : "wss:";
    const prefix = ingress.pathname.replace(/\/+$/, "");
    ingress.pathname = `${prefix}${routePath}`;
    ingress.search = "";
    ingress.hash = "";
    target = ingress;
  }

  target.searchParams.set("token", token);
  for (const [key, value] of Object.entries(params ?? {})) {
    target.searchParams.set(key, value);
  }
  return target.toString();
}

export interface ResolveGatewayWsUrlArgs {
  assistantId: string;
  /** Gateway route to open, e.g. `/v1/live-voice` or `/v1/watch/stream`. */
  routePath: string;
  /** Names the stream in the not-ready error, e.g. `live voice`. */
  label: string;
  /** Extra query params to append after `token`. */
  params?: Record<string, string>;
}

/**
 * Resolve a gateway WebSocket URL for `assistantId`, choosing the transport by
 * deployment kind (see the module doc comment). Live voice, watch, and the pod
 * desktop all route through here.
 *
 * - **Self-hosted / local**: when {@link getSelfHostedIngressUrl} is primed,
 *   connect straight to the user's gateway with the actor edge JWT. No tunnel
 *   token-exchange happens. Throws {@link TunnelWsTokenError} if the ingress is
 *   known but the actor token hasn't been provisioned yet (a brief post-hatch
 *   window), so the caller surfaces a connection failure rather than dialling an
 *   unauthenticated socket. A paired ingress throws
 *   {@link PairedVoiceUnavailableError} first: the paired proxy is HTTP-only,
 *   so no WebSocket transport exists and the caller surfaces the
 *   unavailable reason.
 * - **Cloud**: mint a short-lived tunnel WS token and build the tunnel URL.
 */
export async function resolveGatewayWsUrl({
  assistantId,
  routePath,
  label,
  params,
}: ResolveGatewayWsUrlArgs): Promise<string> {
  const ingressUrl = getSelfHostedIngressUrl();
  if (ingressUrl) {
    if (isPairedGatewayIngress(ingressUrl)) {
      throw new PairedVoiceUnavailableError();
    }
    const token = getSelfHostedActorToken();
    if (!token) {
      throw new TunnelWsTokenError(
        0,
        `Self-hosted ${label} has no actor token yet; the gateway isn't ready.`,
      );
    }
    return buildSelfHostedGatewayWsUrl({
      ingressUrl,
      routePath,
      token,
      params,
    });
  }

  const { token } = await mintTunnelWsToken(assistantId);
  return buildTunnelWsUrl({ assistantId, routePath, token, params });
}

export interface ResolveLiveVoiceWsUrlArgs {
  assistantId: string;
  /** Optional conversation to attach the live-voice session to. */
  conversationId?: string;
}

/**
 * Resolve the live-voice WebSocket URL for the current assistant. Thin wrapper
 * over {@link resolveGatewayWsUrl} for the `/v1/live-voice` route.
 */
export function resolveLiveVoiceWsUrl({
  assistantId,
  conversationId,
}: ResolveLiveVoiceWsUrlArgs): Promise<string> {
  return resolveGatewayWsUrl({
    assistantId,
    routePath: LIVE_VOICE_ROUTE,
    label: "live voice",
    params: conversationId ? { conversationId } : undefined,
  });
}
