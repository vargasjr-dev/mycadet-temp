/**
 * WebSocket half of the plugin ingress surface.
 *
 * A plugin declaring `kind: "websocket"` gets a socket the caller dials, but
 * plugin routes are HTTP-only — there is no second socket to hand off to. So
 * the gateway terminates the connection at the edge and hands each frame to
 * the plugin's route over IPC, one at a time per connection so the plugin
 * observes frames in the order they arrived. IPC rather than a loopback HTTP
 * hop because the socket is the trust boundary: the assistant does not
 * re-verify a caller the gateway has already authorised.
 *
 * Frames travel upstream; nothing travels back. Giving the route's response a
 * meaning on the wire would be inventing a protocol neither side has agreed
 * to, so a failure is logged and the socket is left alone.
 *
 * A frame travels as the request's raw body, so the plugin receives exactly
 * the bytes the caller sent: text or binary, well-formed JSON or not.
 */

import { Server, ServerWebSocket } from "bun";
import { z } from "zod";

import {
  findServableRoute,
  resolveCachedPluginIngress,
} from "../../channels/plugin-ingress-approvals.js";
import { PLUGIN_WEBHOOK_PATH_PATTERN } from "../../channels/plugin-ingress.js";
import type { IngressSigner } from "../../channels/plugin-ingress.js";
import type { RouteDefinition } from "./types.js";
import { getConfig, type GatewayConfig } from "../../config.js";
import { getCredentials } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import {
  resolveCredentialWithRefresh,
  verifySecretWithRefresh,
} from "../../credential-refresh.js";
import {
  ipcCallAssistant,
  type IpcCallOptions,
} from "../../ipc/assistant-client.js";
import { getLogger } from "../../logger.js";
import { verifySignedQueryHandshake } from "../plugin-ingress-handshake.js";
import {
  CADET_TIMESTAMP_HEADER,
  handshakeSignedPayload,
  timestampWithinTolerance,
  verifyCadetSignature,
} from "../cadet-signature.js";
import { isWebsocketUpgradeRequest } from "../utils.js";

const log = getLogger("plugin-webhook-ws");

/**
 * Frames buffered while a delivery is in flight. Matches the STT relay's cap
 * — a caller that outruns the plugin is disconnected rather than allowed to
 * grow the gateway's heap.
 *
 * The count alone is not a memory bound: Bun accepts frames far larger than
 * a webhook payload, so a hundred of them would be gigabytes. Queued bytes
 * are capped as well, and an oversized single frame is refused outright —
 * a frame is a webhook-sized request to the plugin, so
 * `maxWebhookPayloadBytes` is the size that has to hold.
 */
const MAX_PENDING_FRAMES = 100;

/** Total bytes a connection may hold queued, across all pending frames. */
function maxQueuedBytes(config: GatewayConfig): number {
  return config.maxWebhookPayloadBytes * 8;
}

function frameByteLength(frame: string | Uint8Array): number {
  return typeof frame === "string"
    ? Buffer.byteLength(frame, "utf8")
    : frame.byteLength;
}

/** Signature of {@link ipcCallAssistant}, injectable for tests. */
export type IpcCall = (
  method: string,
  params?: Record<string, unknown>,
  opts?: IpcCallOptions,
) => Promise<unknown>;

export const pluginWebhookSocketDataSchema = z.object({
  wsType: z.literal("plugin-webhook"),
  plugin: z.string(),
  path: z.string(),
  queue: z.array(
    z.union([z.string(), z.custom<Uint8Array>((v) => v instanceof Uint8Array)]),
  ),
  queuedBytes: z.number(),
  delivering: z.boolean(),
  closed: z.boolean(),
  ipcCall: z.custom<IpcCall>(() => true).optional(),
});

export type PluginWebhookSocketData = z.infer<
  typeof pluginWebhookSocketDataSchema
>;

/** Discriminate an untyped socket as a plugin webhook socket. */
export function isPluginWebhookSocketData(
  ws: ServerWebSocket<unknown>,
): ws is ServerWebSocket<PluginWebhookSocketData> {
  return pluginWebhookSocketDataSchema.safeParse(ws.data).success;
}

function signingCredentialKey(plugin: string, signer: IngressSigner): string {
  return credentialKey(signer === "cadet" ? "cadet" : plugin, "webhook_secret");
}

/**
 * Upgrade handler for `/webhooks/plugins/:plugin/:path`.
 *
 * Applies the same gate as the HTTP half (see `findServableRoute`) and only
 * for the `websocket` kind, then authenticates the handshake before
 * upgrading. An upgrade cannot be un-done once accepted, so everything is
 * checked first.
 */
export async function handlePluginWebhookWs(
  req: Request,
  server: Server<unknown>,
  plugin: string,
  path: string,
): Promise<Response | undefined> {
  const resolve = resolveCachedPluginIngress;
  const credentials = getCredentials();

  if (!isWebsocketUpgradeRequest(req)) {
    return new Response("Upgrade Required", { status: 426 });
  }

  let route: ReturnType<typeof findServableRoute>;
  try {
    route = findServableRoute(resolve(), plugin, path, "websocket");
  } catch (err) {
    log.error({ err, plugin }, "Failed to resolve plugin ingress");
    return new Response("Internal Server Error", { status: 500 });
  }
  if (!route) {
    // Quiet for the same reason as the HTTP half: anyone can reach this.
    log.debug({ plugin, path }, "No servable websocket ingress route");
    return new Response("Not Found", { status: 404 });
  }

  const secretKey = signingCredentialKey(plugin, route.signer);
  const secret = await resolveCredentialWithRefresh(credentials, secretKey);
  if (!secret) {
    log.warn(
      { plugin, path, signer: route.signer },
      "Plugin webhook secret is not configured — refusing upgrade",
    );
    return new Response("Webhook secret not configured", { status: 409 });
  }

  const url = new URL(req.url);

  // Both branches verify through the refresh helper rather than against the
  // secret read above: one that rotated while the cache still held the old
  // value would otherwise fail an upgrade that is actually valid.
  if (route.handshake === "signed-query") {
    // The caller was handed a URL and nothing else, so the whole credential
    // is in the query string. It carries its own expiry instead of a
    // freshness window: the URL is minted long before it is dialed.
    let rejection: string | undefined;
    const valid = await verifySecretWithRefresh({
      credentials,
      key: secretKey,
      verify: (candidate) => {
        const result = verifySignedQueryHandshake({
          url,
          pathname: url.pathname,
          secret: candidate,
        });
        // Kept for the log line below. On a retry against a refreshed
        // secret this holds the second attempt's reason, which is the one
        // that decided the outcome.
        if (!result.ok) {
          rejection = result.reason;
        }
        return result.ok;
      },
      log,
      label: "Plugin webhook WS signed-query handshake",
    });
    if (!valid) {
      log.warn(
        { plugin, path, signer: route.signer, rejection },
        "Plugin webhook WS: signed-query handshake rejected",
      );
      return new Response("Forbidden", { status: 403 });
    }
  } else {
    // A handshake carries no body to sign, so the signature covers the
    // timestamp and the path instead, and the timestamp bounds how long a
    // captured handshake stays usable.
    const timestamp = req.headers.get(CADET_TIMESTAMP_HEADER);
    if (!timestamp || !timestampWithinTolerance(timestamp)) {
      log.warn(
        { plugin, path },
        "Plugin webhook WS: missing or stale timestamp",
      );
      return new Response("Forbidden", { status: 403 });
    }
    const signed = handshakeSignedPayload(timestamp, url.pathname);
    const valid = await verifySecretWithRefresh({
      credentials,
      key: secretKey,
      verify: (candidate) =>
        verifyCadetSignature(req.headers, signed, candidate),
      log,
      label: "Plugin webhook WS handshake",
    });
    if (!valid) {
      log.warn(
        { plugin, path, signer: route.signer },
        "Plugin webhook WS: signature verification failed",
      );
      return new Response("Forbidden", { status: 403 });
    }
  }

  const upgraded = server.upgrade(req, {
    data: {
      wsType: "plugin-webhook",
      plugin,
      path,
      queue: [],
      queuedBytes: 0,
      delivering: false,
      closed: false,
    } satisfies PluginWebhookSocketData,
  });
  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }
  return undefined;
}

/**
 * Hand one frame to the plugin's route over IPC.
 *
 * The frame travels as the request's raw body, so the plugin receives the
 * bytes the caller sent: text or binary, well-formed JSON or not. Deciding
 * what a frame means is the plugin's job, not the transport's.
 */
async function deliverFrame(
  data: PluginWebhookSocketData,
  frame: string | Uint8Array,
): Promise<void> {
  const { plugin, path } = data;
  const config = getConfig();
  const call = data.ipcCall ?? ipcCallAssistant;
  const bytes =
    typeof frame === "string" ? new TextEncoder().encode(frame) : frame;
  try {
    await call(
      "user_route_post",
      {
        pathParams: { path: `plugins/${plugin}/${path}` },
        queryParams: {},
        headers: {
          "content-type":
            typeof frame === "string"
              ? "text/plain; charset=utf-8"
              : "application/octet-stream",
        },
      },
      { timeoutMs: config.runtimeTimeoutMs, binary: bytes },
    );
  } catch (err) {
    log.warn({ err, plugin, path }, "Plugin webhook frame delivery failed");
  }
}

/**
 * Deliver queued frames one at a time.
 *
 * Serialising is the point: the plugin sees `joined` before `left` because
 * the next call does not start until the previous one settles. A delivery
 * that fails is logged and skipped rather than retried — re-sending would
 * reorder it behind frames that have already arrived.
 */
async function drain(data: PluginWebhookSocketData): Promise<void> {
  if (data.delivering) return;
  data.delivering = true;
  try {
    while (data.queue.length > 0 && !data.closed) {
      const frame = data.queue.shift()!;
      data.queuedBytes -= frameByteLength(frame);
      await deliverFrame(data, frame);
    }
  } finally {
    data.delivering = false;
  }
}

/**
 * Refuse the rest of a connection.
 *
 * Marks it closed before asking for the close: `close` is not immediate, and
 * a caller already outrunning us keeps sending in the meantime. Without this
 * every one of those frames would close again.
 */
function refuse(
  ws: ServerWebSocket<PluginWebhookSocketData>,
  code: number,
  reason: string,
): void {
  ws.data.closed = true;
  ws.data.queue = [];
  ws.data.queuedBytes = 0;
  ws.close(code, reason);
}

export function openPluginWebhookWebsocket(
  ws: ServerWebSocket<PluginWebhookSocketData>,
) {
  log.info(
    { plugin: ws.data.plugin, path: ws.data.path },
    "Plugin webhook WS opened",
  );
}

/**
 * The plugin webhook message arm: queue the frame for the serialised
 * delivery pump, refusing frames the plugin's route could never accept.
 */
export function messagePluginWebhookWebsocket(
  ws: ServerWebSocket<PluginWebhookSocketData>,
  message: string | ArrayBuffer | Uint8Array,
) {
  const data = ws.data;
  if (data.closed) return;

  const frame =
    message instanceof ArrayBuffer ? new Uint8Array(message) : message;
  const size = frameByteLength(frame);

  // A single oversized frame is refused rather than queued: it could
  // never be delivered anyway, since it exceeds what the plugin's route
  // accepts as a webhook payload.
  if (size > getConfig().maxWebhookPayloadBytes) {
    log.warn(
      { plugin: data.plugin, path: data.path, size },
      "Plugin webhook frame exceeds the webhook payload cap — closing connection",
    );
    refuse(ws, 1009, "Frame too large");
    return;
  }

  if (
    data.queue.length >= MAX_PENDING_FRAMES ||
    data.queuedBytes + size > maxQueuedBytes(getConfig())
  ) {
    log.warn(
      {
        plugin: data.plugin,
        path: data.path,
        queued: data.queue.length,
        queuedBytes: data.queuedBytes,
      },
      "Plugin webhook frame buffer overflow — closing connection",
    );
    refuse(ws, 1008, "Buffer overflow");
    return;
  }

  data.queue.push(frame);
  data.queuedBytes += size;
  void drain(data);
}

/**
 * The plugin webhook close arm: mark closed and drop undelivered frames —
 * the caller is gone and the plugin's view should not gain events after the
 * stream ended.
 */
export function closePluginWebhookWebsocket(
  ws: ServerWebSocket<PluginWebhookSocketData>,
  code: number,
  reason: string,
) {
  const data = ws.data;
  data.closed = true;
  const dropped = data.queue.length;
  data.queue = [];
  data.queuedBytes = 0;
  log.info(
    { plugin: data.plugin, path: data.path, code, reason, dropped },
    "Plugin webhook WS closed",
  );
}

export const ROUTES: RouteDefinition[] = [
  {
    path: PLUGIN_WEBHOOK_PATH_PATTERN,
    upgradesOnly: true,
    handler: async (req, params, _getClientIp, server) =>
      (await handlePluginWebhookWs(req, server!, params[0]!, params[1]!)) ??
      new Response(null, { status: 101 }),
  },
];
