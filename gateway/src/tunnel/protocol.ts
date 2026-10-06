import { Buffer } from "node:buffer";

import { z } from "zod";

import {
  decodeBinaryWebSocketFrame,
  type TunnelBinaryWebSocketFrame,
} from "./binary-websocket.js";

export const TUNNEL_TUNNEL_SUBPROTOCOL = "tunnel-tunnel-v1";

export const TUNNEL_FRAME_TYPES = {
  registered: "registered",
  httpRequest: "http_request",
  httpResponse: "http_response",
  websocketOpen: "websocket_open",
  websocketOpened: "websocket_opened",
  websocketOpenError: "websocket_open_error",
  websocketMessage: "websocket_message",
  websocketClose: "websocket_close",
  heartbeat: "heartbeat",
} as const;

export const TUNNEL_WEBSOCKET_MESSAGE_TYPES = {
  text: "text",
  binary: "binary",
} as const;

export type TunnelHeaders = Record<string, string[]>;
export type TunnelWebSocketMessageType =
  (typeof TUNNEL_WEBSOCKET_MESSAGE_TYPES)[keyof typeof TUNNEL_WEBSOCKET_MESSAGE_TYPES];

export type TunnelRegisteredFrame = {
  type: typeof TUNNEL_FRAME_TYPES.registered;
  assistant_id: string;
  public_url: string;
};

export type TunnelHttpRequestFrame = {
  type: typeof TUNNEL_FRAME_TYPES.httpRequest;
  request_id: string;
  method: string;
  path: string;
  raw_query?: string;
  headers: TunnelHeaders;
  body_base64?: string;
};

export type TunnelHttpResponseFrame = {
  type: typeof TUNNEL_FRAME_TYPES.httpResponse;
  request_id: string;
  status_code: number;
  headers?: TunnelHeaders;
  body_base64?: string;
};

export type TunnelWebSocketOpenFrame = {
  type: typeof TUNNEL_FRAME_TYPES.websocketOpen;
  connection_id: string;
  path: string;
  raw_query?: string;
  headers: TunnelHeaders;
  subprotocol?: string;
  binary_messages?: boolean;
};

export type TunnelWebSocketOpenedFrame = {
  type: typeof TUNNEL_FRAME_TYPES.websocketOpened;
  connection_id: string;
};

export type TunnelWebSocketOpenErrorFrame = {
  type: typeof TUNNEL_FRAME_TYPES.websocketOpenError;
  connection_id: string;
  reason?: string;
};

export type TunnelWebSocketMessageFrame = {
  type: typeof TUNNEL_FRAME_TYPES.websocketMessage;
  connection_id: string;
  message_type: TunnelWebSocketMessageType;
  body_base64?: string;
};

export type TunnelWebSocketCloseFrame = {
  type: typeof TUNNEL_FRAME_TYPES.websocketClose;
  connection_id: string;
  code?: number;
  reason?: string;
};

export type TunnelHeartbeatFrame = {
  type: typeof TUNNEL_FRAME_TYPES.heartbeat;
};

export type TunnelFrame =
  | TunnelBinaryWebSocketFrame
  | TunnelRegisteredFrame
  | TunnelHttpRequestFrame
  | TunnelHttpResponseFrame
  | TunnelWebSocketOpenFrame
  | TunnelWebSocketOpenedFrame
  | TunnelWebSocketOpenErrorFrame
  | TunnelWebSocketMessageFrame
  | TunnelWebSocketCloseFrame
  | TunnelHeartbeatFrame;

export type TunnelWebSocketInboundFrame =
  | TunnelBinaryWebSocketFrame
  | TunnelWebSocketOpenFrame
  | TunnelWebSocketMessageFrame
  | TunnelWebSocketCloseFrame;

const headersSchema = z.record(z.string(), z.array(z.string()));

const registeredFrameSchema = z.object({
  type: z.literal(TUNNEL_FRAME_TYPES.registered),
  assistant_id: z.string(),
  public_url: z.string(),
});

const httpRequestFrameSchema = z.object({
  type: z.literal(TUNNEL_FRAME_TYPES.httpRequest),
  request_id: z.string(),
  method: z.string(),
  path: z.string(),
  raw_query: z.string().optional(),
  headers: headersSchema,
  body_base64: z.string().optional(),
});

const websocketOpenFrameSchema = z.object({
  type: z.literal(TUNNEL_FRAME_TYPES.websocketOpen),
  connection_id: z.string(),
  path: z.string(),
  raw_query: z.string().optional(),
  headers: headersSchema,
  subprotocol: z.string().optional(),
  binary_messages: z.boolean().optional(),
});

const websocketMessageTypeSchema = z.enum([
  TUNNEL_WEBSOCKET_MESSAGE_TYPES.text,
  TUNNEL_WEBSOCKET_MESSAGE_TYPES.binary,
]);

const websocketMessageFrameSchema = z.object({
  type: z.literal(TUNNEL_FRAME_TYPES.websocketMessage),
  connection_id: z.string(),
  message_type: websocketMessageTypeSchema,
  body_base64: z.string().optional(),
});

const websocketCloseFrameSchema = z.object({
  type: z.literal(TUNNEL_FRAME_TYPES.websocketClose),
  connection_id: z.string(),
  code: z.number().optional(),
  reason: z.string().optional(),
});

const heartbeatFrameSchema = z.object({
  type: z.literal(TUNNEL_FRAME_TYPES.heartbeat),
});

const inboundFrameSchema = z.discriminatedUnion("type", [
  registeredFrameSchema,
  httpRequestFrameSchema,
  websocketOpenFrameSchema,
  websocketMessageFrameSchema,
  websocketCloseFrameSchema,
  heartbeatFrameSchema,
]);

export function parseTunnelFrame(data: unknown): TunnelFrame | undefined {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : undefined;
  if (bytes?.[0] === 1) {
    return decodeBinaryWebSocketFrame(bytes);
  }
  const raw = decodeWebSocketData(data);
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const result = inboundFrameSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

function decodeWebSocketData(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  return undefined;
}
