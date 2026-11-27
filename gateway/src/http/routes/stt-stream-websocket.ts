/**
 * `/v1/stt/stream`: the client's dictation audio, proxied to the runtime's
 * streaming transcriber.
 *
 * The token gate and the frame pump are `runtime-audio-stream.ts`'s, shared
 * with the watch stream next door, so the two client-facing audio proxies
 * cannot drift on what a valid caller looks like. Where they deliberately do
 * differ is who may open one: watch is guardian-only and pins the upgrade to
 * the binding, and dictation takes any valid actor, which is why that pin is a
 * route opt-in rather than part of the shared gate.
 *
 * A cloud assistant is reached through tunnel, which validates the browser's
 * own token and attests the caller to the bridge; there is no edge JWT on that
 * path to validate. So a tunnel-attested caller with the bridge proof is
 * admitted here the way live voice and watch admit one, minus their guardian
 * check: tunnel only mints a token for a user with access to this assistant,
 * which is the same standing an actor token proves.
 *
 * The rest of what is this route's own is the query it accepts and carries
 * upstream.
 */

import { Server, ServerWebSocket } from "bun";
import type { RouteDefinition } from "./types.js";
import { z } from "zod";

import {
  authorizeRuntimeAudioStream,
  closeRuntimeAudioStream,
  messageRuntimeAudioStream,
  openRuntimeAudioStream,
  runtimeAudioStreamSocketState,
} from "./runtime-audio-stream.js";
import {
  acceptsTunnelAttestation,
  extractTunnelAttestedContext,
} from "./guardian-pin.js";
import { getConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { requestHasTunnelBridgeAuth } from "../../tunnel/bridge-auth.js";

const log = getLogger("stt-stream-ws");

export const sttStreamSocketDataSchema = runtimeAudioStreamSocketState.extend({
  wsType: z.literal("stt-stream"),
  provider: z.string().optional(),
  mimeType: z.string(),
  sampleRate: z.number().optional(),
});

export type SttStreamSocketData = z.infer<typeof sttStreamSocketDataSchema>;

/** Discriminate an untyped socket as an STT stream socket. */
export function isSttStreamSocketData(
  ws: ServerWebSocket<unknown>,
): ws is ServerWebSocket<SttStreamSocketData> {
  return sttStreamSocketDataSchema.safeParse(ws.data).success;
}

/**
 * The `/v1/stt/stream` WebSocket upgrade handler: proxies client STT audio
 * frames to the runtime's /v1/stt/stream endpoint.
 *
 * The gateway authenticates the downstream client using an edge JWT and
 * then opens an upstream connection to the runtime with a short-lived
 * gateway service token. This keeps the runtime unreachable from the
 * public internet while allowing authenticated clients to stream audio
 * for real-time transcription.
 */
export function handleSttStreamWs(
  req: Request,
  server: Server<unknown>,
): Response | undefined {
  const config = getConfig();
  // Any valid actor, deliberately. Dictation is the user's own words going
  // to a transcriber and back; it is not a guardian-only surface, and the
  // watch stream's `guardian-pin` check is exactly what this route does not
  // want.
  //
  // The tunnel path first, as live voice and watch take it. A direct
  // request to a reachable gateway can spoof the X-Tunnel-* names but cannot
  // know the bridge proof, and an attestation without the proof falls
  // through to the token gate rather than being trusted.
  let managedCaller = false;
  if (acceptsTunnelAttestation(config) && config.runtimeProxyRequireAuth) {
    const tunnelContext = extractTunnelAttestedContext(req);
    if (tunnelContext) {
      if (requestHasTunnelBridgeAuth(req)) {
        log.info(
          { userId: tunnelContext.userId, orgId: tunnelContext.orgId },
          "STT stream WS: authenticated via tunnel-attested managed context",
        );
        managedCaller = true;
      } else {
        log.warn("STT stream WS: ignoring tunnel context without bridge proof");
      }
    }
  }
  if (!managedCaller) {
    const auth = authorizeRuntimeAudioStream(req, config, log);
    if (!auth.ok) {
      return auth.response;
    }
  }

  // ── Query parameters ──
  // mimeType is required; provider is optional compatibility metadata
  // (the runtime resolves the transcriber from config, not from the query).
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider") ?? undefined;
  const mimeType = url.searchParams.get("mimeType");

  if (!mimeType) {
    return new Response("Missing required query parameter: mimeType", {
      status: 400,
    });
  }

  const sampleRateRaw = url.searchParams.get("sampleRate");
  const sampleRate = sampleRateRaw ? parseInt(sampleRateRaw, 10) : undefined;

  const upgraded = server.upgrade(req, {
    data: {
      wsType: "stt-stream",
      provider,
      mimeType,
      sampleRate,
    } satisfies SttStreamSocketData,
  });

  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  // Return undefined to indicate upgrade was handled
  return undefined;
}

const label = "STT stream";

export const openSttStreamWebsocket = (
  ws: ServerWebSocket<SttStreamSocketData>,
) =>
  openRuntimeAudioStream({
    ws,
    label,
    upstreamPath: "/v1/stt/stream",
  });

export const messageSttStreamWebsocket = (
  ws: ServerWebSocket<SttStreamSocketData>,
  message: string | ArrayBuffer | Uint8Array<ArrayBufferLike>,
) => messageRuntimeAudioStream({ ws, message, label });

export const closeSttStreamWebsocket = (
  ws: ServerWebSocket<SttStreamSocketData>,
  code: number,
  reason: string,
) => closeRuntimeAudioStream({ ws, code, reason, label });

export const ROUTES: RouteDefinition[] = [
  {
    path: "/stt/stream",
    upgradesOnly: true,
    handler: (req, _params, _getClientIp, server) =>
      handleSttStreamWs(req, server!) ?? new Response(null, { status: 101 }),
  },
  {
    path: /^\/assistants\/([^/]+)\/stt\/stream\/?$/,
    upgradesOnly: true,
    handler: (req, _params, _getClientIp, server) =>
      handleSttStreamWs(req, server!) ?? new Response(null, { status: 101 }),
  },
];
