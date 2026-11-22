import { beforeEach, describe, expect, mock, test } from "bun:test";

type FakeClient = {
  getConnectionHealth: () => {
    connected: boolean;
    lastLivenessAt?: number;
  };
};

let slackClient: FakeClient | null = null;
let discordClient: FakeClient | null = null;

// The routes resolve the live clients straight from each channel's
// lifecycle singleton — the test swaps those singletons the way the
// credential watcher swaps the real ones.
mock.module("../slack/lifecycle.js", () => ({
  getSlackSocketClient: () => slackClient,
}));
mock.module("../discord/lifecycle.js", () => ({
  getDiscordGatewayClient: () => discordClient,
}));

const { channelSocketHealthRoutes } =
  await import("./channel-socket-health-handlers.js");

function route(channel: string) {
  const [only] = channelSocketHealthRoutes;
  return async () => only.handler({ channel });
}

beforeEach(() => {
  slackClient = null;
  discordClient = null;
});

describe("channel_socket_health", () => {
  test("reports a live connection with its last proof of liveness", async () => {
    slackClient = {
      getConnectionHealth: () => ({
        connected: true,
        lastLivenessAt: 1_700_000_000_000,
      }),
    };

    expect(await route("slack")()).toEqual({
      channel: "slack",
      status: "connected",
      lastLivenessAt: 1_700_000_000_000,
    });
  });

  test("omits the timestamp when nothing has proved liveness yet", async () => {
    // A connection's first keepalive is a full interval after it opens, so
    // this is the normal state of a healthy reconnect, not a fault.
    slackClient = {
      getConnectionHealth: () => ({
        connected: true,
        lastLivenessAt: undefined,
      }),
    };

    expect(await route("slack")()).toEqual({
      channel: "slack",
      status: "connected",
    });
  });

  test("reports a running client with no live socket as disconnected", async () => {
    slackClient = {
      getConnectionHealth: () => ({
        connected: false,
        lastLivenessAt: undefined,
      }),
    };

    expect(await route("slack")()).toMatchObject({ status: "disconnected" });
  });

  test("distinguishes an absent client from a dead one", async () => {
    // No client means no credentials, which the local credential checks
    // already report. Calling that "disconnected" would double-report a
    // channel the user never set up as a channel that broke.
    expect(await route("slack")()).toEqual({
      channel: "slack",
      status: "not_configured",
    });
  });

  test("a channel with no gateway-owned socket is unsupported", async () => {
    // Telegram's ingress is a webhook; its delivery health is a property of a
    // registration the daemon reads directly, not of a socket held here.
    expect(await route("telegram")()).toEqual({
      channel: "telegram",
      status: "unsupported",
    });
  });

  test("reads the client through the getter on every call", async () => {
    // Clients are torn down and rebuilt on a credential change, so a captured
    // reference would keep answering for a client that is no longer live.
    expect(await route("discord")()).toMatchObject({
      status: "not_configured",
    });

    discordClient = {
      getConnectionHealth: () =>
        ({ connected: true, lastLivenessAt: undefined }) as never,
    };
    expect(await route("discord")()).toMatchObject({ status: "connected" });
  });
});
