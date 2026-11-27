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
import {
  DISCORD_CHANNEL_CREDENTIAL_SPEC,
  readServiceCredentialsResult,
  SLACK_CHANNEL_CREDENTIAL_SPEC,
  type ServiceCredentialSpec,
} from "../credential-reader.js";
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

/** The credential spec whose presence distinguishes unconfigured from down. */
const credentialSpecs: Partial<
  Record<ChannelSocketHealthIpcParams["channel"], ServiceCredentialSpec>
> = {
  slack: SLACK_CHANNEL_CREDENTIAL_SPEC,
  discord: DISCORD_CHANNEL_CREDENTIAL_SPEC,
};

/**
 * Read the channel's credential set through the same spec-driven path the
 * credential watcher polls, so "is it configured" is answered by the store
 * rather than inferred from the client's absence.
 */
async function readChannelCredentials(
  channel: ChannelSocketHealthIpcParams["channel"],
): Promise<"ok" | "missing" | "unreachable" | null> {
  const override = _credentialReadForTests[channel];
  if (override) {
    return override();
  }
  const spec = credentialSpecs[channel];
  if (!spec) {
    return null;
  }
  const read = await readServiceCredentialsResult(spec);
  return read.status;
}

/**
 * Test-only seam: per-channel credential-read outcomes, checked before the
 * real spec-driven read. Exists so the socket-health tests can drive the
 * "stored credential, no live client" discrimination without masking the
 * credential-reader module process-wide.
 */
export const _credentialReadForTests: Partial<
  Record<
    ChannelSocketHealthIpcParams["channel"],
    () => Promise<"ok" | "missing" | "unreachable">
  >
> = {};

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
    handler: async (params?: Record<string, unknown>) => {
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
        // A null client and a stored credential is a socket that has not come
        // up (or a boot the watcher missed), not an unconfigured channel:
        // reporting not_configured here sent users hunting credentials they
        // had already entered, and only a restart repaired the real state.
        const read = await readChannelCredentials(channel);
        if (read === "ok") {
          return {
            channel,
            status: "disconnected",
          } satisfies ChannelSocketHealthIpcResponse;
        }
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
