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

const { channelSocketHealthRoutes, _credentialReadForTests } =
  await import("./channel-socket-health-handlers.js");

function route(channel: string) {
  const [only] = channelSocketHealthRoutes;
  return async () => only.handler({ channel });
}

beforeEach(() => {
  slackClient = null;
  discordClient = null;
  delete _credentialReadForTests.slack;
  delete _credentialReadForTests.discord;
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
    // No client and no stored credential: the channel was never set up.
    // Calling that "disconnected" would report a channel the user never set
    // up as a channel that broke.
    _credentialReadForTests.slack = async () => "missing";

    expect(await route("slack")()).toEqual({
      channel: "slack",
      status: "not_configured",
    });
  });

  test("a stored credential with no live client is disconnected, not unconfigured", async () => {
    // The case this fixes: the token is in the store, the gateway client has
    // not booted (a missed watcher event, a boot racing the write), and the
    // old answer — "credentials are not configured" — sent the user hunting
    // credentials they had already entered. The socket is down; the setup is
    // done.
    _credentialReadForTests.discord = async () => "ok";

    expect(await route("discord")()).toEqual({
      channel: "discord",
      status: "disconnected",
    });
  });

  test("an unreachable store stays not_configured rather than claiming a fault", async () => {
    // The store cannot be read, so nothing is known; the readiness layer
    // treats this as indeterminate instead of sending the user to setup.
    _credentialReadForTests.discord = async () => "unreachable";

    expect(await route("discord")()).toEqual({
      channel: "discord",
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
    const connectedClient: FakeClient = {
      getConnectionHealth: () => ({
        connected: true,
        lastLivenessAt: undefined,
      }),
    };
    discordClient = connectedClient;
    expect(await route("discord")()).toMatchObject({ status: "connected" });

    discordClient = null;
    _credentialReadForTests.discord = async () => "ok";
    expect(await route("discord")()).toMatchObject({ status: "disconnected" });
  });
});
