/**
 * `/v1/desktop/stream`: a containerized assistant's on-demand desktop, proxied
 * to the runtime as a raw RFB (VNC) byte pipe with close codes relayed
 * verbatim. Guardian-only: the proxy replaces the caller's identity upstream,
 * so this upgrade is the only place a non-guardian actor can be refused.
 */

import { Server, ServerWebSocket } from "bun";

import {
  createRuntimeAudioStreamHandlers,
  runtimeAudioStreamSocketState,
} from "./runtime-audio-stream.js";
import { authorizeGuardianStream } from "./guardian-pin.js";
import { getConfig } from "../../config.js";
import { z } from "zod";

import { getLogger } from "../../logger.js";

const log = getLogger("desktop-stream-ws");

export const desktopStreamSocketDataSchema = z.object({
  wsType: z.literal("desktop-stream"),
  ...runtimeAudioStreamSocketState,
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
    } satisfies DesktopStreamSocketData,
  });

  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  return undefined;
}

/** `Bun.serve` handlers pumping RFB bytes to the runtime's `/v1/desktop/stream`. */
const {
  open: openDesktopStreamWebsocket,
  message: messageDesktopStreamWebsocket,
  close: closeDesktopStreamWebsocket,
} = createRuntimeAudioStreamHandlers<DesktopStreamSocketData>({
  upstreamPath: "/v1/desktop/stream",
  log,
  label: "desktop stream",
  // RFB has no resync: one dropped frame corrupts the framebuffer for the
  // rest of the session, so a drop ends it. The JSON streams next door do
  // not opt in.
  closeOnDroppedFrame: true,
});

export {
  openDesktopStreamWebsocket,
  messageDesktopStreamWebsocket,
  closeDesktopStreamWebsocket,
};
