/**
 * IPC route exposing whether a socket-backed channel is currently receiving.
 *
 * The gateway owns the inbound sockets, and the daemon owns the readiness
 * surface that reports channel health to the user, so the answer has to cross
 * the boundary. Webhook channels need no equivalent: their delivery health is
 * a property of a registration, which the daemon can read from the provider
 * directly.
 *
 * Keyed by channel rather than split per channel, because the question and the
 * answer are the same for every socket transport; only the proof of liveness
 * differs, and each client reports that in its own terms.
 */

import {
  ChannelSocketHealthIpcParamsSchema,
  type ChannelSocketHealthIpcParams,
  type ChannelSocketHealthIpcResponse,
} from "@mycadet/gateway-client/gateway-ipc-contracts";

import { getDiscordGatewayClient } from "../discord/lifecycle.js";
import { getSlackSocketClient } from "../slack/lifecycle.js";
import type { ChannelConnectionHealth } from "../channels/types.js";
import type { IpcRoute } from "./server.js";

/** The slice of a socket-backed channel client this route reads. */
export type SocketHealthSource = {
  getConnectionHealth(): ChannelConnectionHealth;
};

/**
 * Clients are supplied as getters, not values: each is torn down and rebuilt
 * on a credential change, so a captured reference would answer for a client
 * that is no longer the live one.
 */
export type SocketHealthSources = Partial<
  Record<
    ChannelSocketHealthIpcParams["channel"],
    () => SocketHealthSource | null
  >
>;

/**
 * The live channel clients' getters, resolved straight from each channel's
 * lifecycle singleton. Each client is torn down and rebuilt on a credential
 * change, so the getter indirection keeps the teardown/rebuild lifecycle
 * reading through unchanged — the routes resolve `sources` at request time
 * the way `getConfig()` resolves config.
 */
const sources: SocketHealthSources = {
  slack: getSlackSocketClient,
  discord: getDiscordGatewayClient,
};

export const channelSocketHealthRoutes: IpcRoute[] = [
  {
    method: "channel_socket_health",
    schema: ChannelSocketHealthIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { channel } = ChannelSocketHealthIpcParamsSchema.parse(params);
      const source = sources[channel];
      if (!source) {
        return {
          channel,
          status: "unsupported",
        } satisfies ChannelSocketHealthIpcResponse;
      }
      const client = source();
      if (!client) {
        return {
          channel,
          status: "not_configured",
        } satisfies ChannelSocketHealthIpcResponse;
      }
      const health = client.getConnectionHealth();
      return {
        channel,
        status: health.connected ? "connected" : "disconnected",
        ...(health.lastLivenessAt === undefined
          ? {}
          : { lastLivenessAt: health.lastLivenessAt }),
      } satisfies ChannelSocketHealthIpcResponse;
    },
  },
];
