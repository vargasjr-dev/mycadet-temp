/**
 * `/v1/desktop/stream`: a containerized assistant's on-demand desktop, proxied
 * to the runtime as a raw RFB (VNC) byte pipe with close codes relayed
 * verbatim. Guardian-only: the proxy replaces the caller's identity upstream,
 * so this upgrade is the only place a non-guardian actor can be refused.
 */

import { Server, ServerWebSocket } from "bun";
import type { RouteDefinition } from "./types.js";

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

const log = getLogger("desktop-stream-ws");

export const desktopStreamSocketDataSchema =
  runtimeAudioStreamSocketState.extend({
    wsType: z.literal("desktop-stream"),
  });

export type DesktopStreamSocketData = z.infer<
  typeof desktopStreamSocketDataSchema
>;

/** Discriminate an untyped socket as a desktop stream socket. */
export function isDesktopStreamSocketData(
  ws: ServerWebSocket<unknown>,
): ws is ServerWebSocket<DesktopStreamSocketData> {
  return desktopStreamSocketDataSchema.safeParse(ws.data).success;
}

/** The `/v1/desktop/stream` upgrade handler; the route takes no parameters. */
export async function handleDesktopStreamWs(
  req: Request,
  server: Server<unknown>,
): Promise<Response | undefined> {
  const config = getConfig();
  const denied = await authorizeGuardianStream(req, config, log);
  if (denied) {
    return denied;
  }

  const upgraded = server.upgrade(req, {
    data: {
      wsType: "desktop-stream",
    },
  });

  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  return undefined;
}

const label = "desktop stream";

export const openDesktopStreamWebsocket = (
  ws: ServerWebSocket<DesktopStreamSocketData>,
) =>
  openRuntimeAudioStream({
    ws,
    label,
    closeOnDroppedFrame: true,
    upstreamPath: "/v1/desktop/stream",
  });

export const messageDesktopStreamWebsocket = (
  ws: ServerWebSocket<DesktopStreamSocketData>,
  message: string | ArrayBuffer | Uint8Array<ArrayBufferLike>,
) => messageRuntimeAudioStream({ ws, message, label });

export const closeDesktopStreamWebsocket = (
  ws: ServerWebSocket<DesktopStreamSocketData>,
  code: number,
  reason: string,
) => closeRuntimeAudioStream({ ws, code, reason, label });

export const ROUTES: RouteDefinition[] = [
  {
    path: "/desktop/stream",
    upgradesOnly: true,
    handler: async (req, _params, _getClientIp, server) =>
      (await handleDesktopStreamWs(req, server!)) ??
      new Response(null, { status: 101 }),
  },
  {
    path: /^\/assistants\/([^/]+)\/desktop\/stream\/?$/,
    upgradesOnly: true,
    handler: async (req, _params, _getClientIp, server) =>
      (await handleDesktopStreamWs(req, server!)) ??
      new Response(null, { status: 101 }),
  },
];
