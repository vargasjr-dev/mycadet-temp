/**
 * `/v1/watch/stream`: a watch session's narration, proxied to the runtime.
 *
 * The client half of a watch session is a microphone and this socket
 * (`clients/web/src/domains/chat/watch/watch-controller.ts`); the runtime half
 * turns the narration into a timeline and decides when to read the user's
 * screen (`assistant/src/runtime/routes/watch-routes.ts`). Neither can reach
 * the other directly: the runtime is unreachable from outside the private
 * network, so this is the hop that makes the feature work from a browser at
 * all.
 *
 * The token gate and the frame pump are `runtime-audio-stream.ts`'s, shared
 * with `/v1/stt/stream`: the two carry different audio to different ends of
 * the runtime and are otherwise the same proxy, so they are one implementation
 * with two queries rather than two implementations that agree today.
 *
 * What is this route's own is who may open it. Watch is guardian-only and
 * dictation is not, so the pin is opted into here rather than added to the
 * shared gate, where it would take dictation with it.
 */

import { Server, ServerWebSocket } from "bun";

import {
  closeRuntimeAudioStream,
  messageRuntimeAudioStream,
  openRuntimeAudioStream,
  runtimeAudioStreamSocketState,
} from "./runtime-audio-stream.js";
import { authorizeGuardianStream } from "./guardian-pin.js";
import { getConfig } from "../../config.js";
import { z } from "zod";

import { getLogger } from "../../logger.js";

const log = getLogger("watch-stream-ws");

export const watchStreamSocketDataSchema = runtimeAudioStreamSocketState.extend(
  {
    wsType: z.literal("watch-stream"),
    mimeType: z.string(),
    sampleRate: z.number().optional(),
    conversationId: z.string().optional(),
    clientId: z.string().optional(),
    captureDisplayId: z.number().optional(),
    captureWindowId: z.number().optional(),
  },
);

export type WatchStreamSocketData = z.infer<typeof watchStreamSocketDataSchema>;

/** Discriminate an untyped socket as a watch stream socket. */
export function isWatchStreamSocketData(
  ws: ServerWebSocket<unknown>,
): ws is ServerWebSocket<WatchStreamSocketData> {
  return watchStreamSocketDataSchema.safeParse(ws.data).success;
}

/**
 * Read one capture id off the query string: absent or blank is no id, and
 * anything that is not a whole number is a request to refuse rather than
 * forward, since the runtime would refuse it too and a session opened on a
 * mangled id would read the whole screen while the client framed one window.
 */
function parseCaptureId(
  params: URLSearchParams,
  name: "captureDisplayId" | "captureWindowId",
): { value: number | undefined } | { error: string } {
  const raw = params.get(name)?.trim();
  if (!raw) {
    return { value: undefined };
  }
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    return { error: `${name} must be a whole number` };
  }
  return { value: Number(raw) };
}

/**
 * Create the upgrade handler for `/v1/watch/stream`.
 *
 * Authenticates the downstream caller here and dials upstream with a
 * short-lived service token, which is what lets the runtime resolve the acting
 * principal from its own guardian rather than from anything the client sent.
 *
 * **Guardian-only, the way live voice is, and for a sharper reason.** The
 * daemon resolves whose screen to observe from the guardian binding and never
 * from the request, so a session opened by any other actor is still bound to
 * the guardian and still reads the guardian's screen. The proxy also replaces
 * the caller's identity with a service token upstream, leaving the daemon no
 * way to tell one actor from another. This upgrade is therefore the only place
 * a non-guardian actor can be refused, so it is refused here.
 */
export async function handleWatchStreamWs(
  req: Request,
  server: Server<unknown>,
): Promise<Response | undefined> {
  const config = getConfig();
  const denied = await authorizeGuardianStream(req, config, log);
  if (denied) {
    return denied;
  }

  const url = new URL(req.url);
  const mimeType = url.searchParams.get("mimeType");
  if (!mimeType) {
    return new Response("Missing required query parameter: mimeType", {
      status: 400,
    });
  }

  const sampleRateRaw = url.searchParams.get("sampleRate");
  const sampleRate = sampleRateRaw ? parseInt(sampleRateRaw, 10) : undefined;
  const conversationId =
    url.searchParams.get("conversationId")?.trim() || undefined;
  const clientId = url.searchParams.get("clientId")?.trim() || undefined;
  const captureDisplay = parseCaptureId(url.searchParams, "captureDisplayId");
  if ("error" in captureDisplay) {
    return new Response(captureDisplay.error, { status: 400 });
  }
  const captureWindow = parseCaptureId(url.searchParams, "captureWindowId");
  if ("error" in captureWindow) {
    return new Response(captureWindow.error, { status: 400 });
  }
  if (captureDisplay.value !== undefined && captureWindow.value !== undefined) {
    return new Response("captureDisplayId and captureWindowId are exclusive", {
      status: 400,
    });
  }

  const upgraded = server.upgrade(req, {
    data: {
      wsType: "watch-stream",
      mimeType,
      sampleRate,
      conversationId,
      clientId,
      captureDisplayId: captureDisplay.value,
      captureWindowId: captureWindow.value,
    } satisfies WatchStreamSocketData,
  });

  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  return undefined;
}

const label = "watch stream";

export const openWatchStreamWebsocket = (
  ws: ServerWebSocket<WatchStreamSocketData>,
) =>
  openRuntimeAudioStream({
    ws,
    label,
    closeOnDroppedFrame: true,
    upstreamPath: "/v1/watch/stream",
  });

export const messageWatchStreamWebsocket = (
  ws: ServerWebSocket<WatchStreamSocketData>,
  message: string | ArrayBuffer | Uint8Array<ArrayBufferLike>,
) => messageRuntimeAudioStream({ ws, message, label });

export const closeWatchStreamWebsocket = (
  ws: ServerWebSocket<WatchStreamSocketData>,
  code: number,
  reason: string,
) => closeRuntimeAudioStream({ ws, code, reason, label });
