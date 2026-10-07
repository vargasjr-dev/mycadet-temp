import { afterEach, describe, expect, test } from "bun:test";

import {
  buildTunnelLiveVoiceUrl,
  tunnelHostForPlatformUrl,
  tunnelWsScheme,
} from "./tunnel.js";

const ORIGINAL_TUNNEL_HOST = process.env.CADET_TUNNEL_HOST;

afterEach(() => {
  if (ORIGINAL_TUNNEL_HOST === undefined) {
    delete process.env.CADET_TUNNEL_HOST;
  } else {
    process.env.CADET_TUNNEL_HOST = ORIGINAL_TUNNEL_HOST;
  }
});

describe("tunnelHostForPlatformUrl", () => {
  test("maps a platform host onto its environment's tunnel", () => {
    delete process.env.CADET_TUNNEL_HOST;
    expect(tunnelHostForPlatformUrl("https://cloud.mycadet.ai")).toBe(
      "tunnel.mycadet.ai",
    );
    expect(tunnelHostForPlatformUrl("https://dev-cloud.mycadet.ai")).toBe(
      "tunnel-dev.mycadet.ai",
    );
  });

  test("falls back to production tunnel for a host outside the convention", () => {
    delete process.env.CADET_TUNNEL_HOST;
    // A local platform predicts no tunnel of its own; guessing one would be
    // worse than dialing the host that certainly exists.
    expect(tunnelHostForPlatformUrl("http://localhost:8000")).toBe(
      "tunnel.mycadet.ai",
    );
    expect(tunnelHostForPlatformUrl("not a url")).toBe("tunnel.mycadet.ai");
  });

  test("the env override wins, which is how a local vel up tunnel is reached", () => {
    process.env.CADET_TUNNEL_HOST = "localhost:8501";
    expect(tunnelHostForPlatformUrl("https://cloud.mycadet.ai")).toBe(
      "localhost:8501",
    );
  });
});

describe("tunnelWsScheme", () => {
  test("downgrades to ws only for loopback", () => {
    expect(tunnelWsScheme("localhost:8501")).toBe("ws");
    expect(tunnelWsScheme("127.0.0.1:8501")).toBe("ws");
    expect(tunnelWsScheme("tunnel.mycadet.ai")).toBe("wss");
  });
});

describe("buildTunnelLiveVoiceUrl", () => {
  test("prefixes the assistant id, which is what selects the tunnel", () => {
    delete process.env.CADET_TUNNEL_HOST;
    const url = new URL(
      buildTunnelLiveVoiceUrl({
        platformUrl: "https://cloud.mycadet.ai",
        assistantId: "01a02514-e452-7019-88d5-30828f42cf17",
        token: "tok_abc",
      }),
    );

    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("tunnel.mycadet.ai");
    expect(url.pathname).toBe(
      "/01a02514-e452-7019-88d5-30828f42cf17/v1/live-voice",
    );
    expect(url.searchParams.get("token")).toBe("tok_abc");
  });

  test("encodes a token rather than letting it break the query", () => {
    delete process.env.CADET_TUNNEL_HOST;
    const url = new URL(
      buildTunnelLiveVoiceUrl({
        platformUrl: "https://cloud.mycadet.ai",
        assistantId: "a1",
        token: "a+b/c=&d",
      }),
    );
    expect(url.searchParams.get("token")).toBe("a+b/c=&d");
  });

  test("uses ws against a loopback tunnel so a local stack is reachable", () => {
    process.env.CADET_TUNNEL_HOST = "localhost:8501";
    const url = new URL(
      buildTunnelLiveVoiceUrl({
        platformUrl: "http://localhost:8000",
        assistantId: "a1",
        token: "t",
      }),
    );
    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe("localhost:8501");
  });
});
