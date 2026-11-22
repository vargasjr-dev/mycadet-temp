import { afterEach, describe, test, expect, mock } from "bun:test";
import {
  createFakeDownstreamWs,
  makeConfig,
  makeFakeServer,
  mintEdgeToken,
  mintServiceEdgeToken,
  settle,
  startFakeRuntime,
  upgradedData,
  waitFor,
  type FakeRuntime,
} from "./runtime-stream-test-utils.js";

import type { SttStreamSocketData } from "../http/routes/stt-stream-websocket.js";
import { setTunnelBridgeAuthHeader } from "../tunnel/bridge-auth.js";
const mockFindCadetGuardian = mock(
  async (): Promise<{ principalId: string } | null> => ({
    principalId: "somebody-who-is-not-the-caller",
  }),
);
mock.module("../auth/guardian-bootstrap.js", () => ({
  findCadetGuardian: () => mockFindCadetGuardian(),
}));

let testConfig = makeConfig();
mock.module("../config.js", () => ({
  getConfig: () => testConfig,
}));

const {
  closeSttStreamWebsocket,
  handleSttStreamWs,
  messageSttStreamWebsocket,
  openSttStreamWebsocket,
} = await import("../http/routes/stt-stream-websocket.js");

// ---------------------------------------------------------------------------
// handleSttStreamWs — upgrade handler tests
// ---------------------------------------------------------------------------

describe("handleSttStreamWs", () => {
  const TEST_TOKEN = mintEdgeToken();

  test("upgrades when token query parameter is valid and required params present", () => {
    const config = makeConfig();
    testConfig = config;
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}&provider=deepgram&mimeType=audio/webm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handleSttStreamWs(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("upgrades when Authorization header is valid", () => {
    const config = makeConfig();
    testConfig = config;
    const req = new Request(
      "http://localhost:7830/v1/stt/stream?provider=deepgram&mimeType=audio/webm",
      {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
      },
    );
    const server = makeFakeServer();
    const res = handleSttStreamWs(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("returns 401 when no token is provided", () => {
    const config = makeConfig();
    testConfig = config;
    const req = new Request(
      "http://localhost:7830/v1/stt/stream?provider=deepgram&mimeType=audio/webm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handleSttStreamWs(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 401 when token is invalid", () => {
    const config = makeConfig();
    testConfig = config;
    const req = new Request(
      "http://localhost:7830/v1/stt/stream?token=bad-token&provider=deepgram&mimeType=audio/webm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handleSttStreamWs(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 401 for service tokens (requires actor principal)", () => {
    const serviceToken = mintServiceEdgeToken();
    const config = makeConfig();
    testConfig = config;
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${serviceToken}&provider=deepgram&mimeType=audio/webm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handleSttStreamWs(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("upgrades successfully when provider is omitted (config-authoritative)", () => {
    const config = makeConfig();
    testConfig = config;
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}&mimeType=audio/webm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handleSttStreamWs(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);

    const data = upgradedData<SttStreamSocketData>(server);
    expect(data.provider).toBeUndefined();
    expect(data.mimeType).toBe("audio/webm");
  });

  test("returns 400 when mimeType is missing", () => {
    const config = makeConfig();
    testConfig = config;
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}&provider=deepgram`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handleSttStreamWs(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(400);
  });

  test("returns 400 when mimeType is missing and provider is also missing", () => {
    const config = makeConfig();
    testConfig = config;
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handleSttStreamWs(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(400);
  });

  test("returns 426 when upgrade header is not websocket", () => {
    const config = makeConfig();
    testConfig = config;
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}&provider=deepgram&mimeType=audio/webm`,
    );
    const server = makeFakeServer();
    const res = handleSttStreamWs(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(426);
  });

  test("returns 500 when Bun.serve upgrade fails", () => {
    const config = makeConfig();
    testConfig = config;
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}&provider=deepgram&mimeType=audio/webm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer(false); // upgrade returns false
    const res = handleSttStreamWs(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(500);
  });

  test("allows unauthenticated upgrade when auth is disabled (dev bypass)", () => {
    const config = makeConfig({ runtimeProxyRequireAuth: false });
    testConfig = config;
    const req = new Request(
      "http://localhost:7830/v1/stt/stream?provider=deepgram&mimeType=audio/webm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handleSttStreamWs(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("upgrades when auth is disabled and provider is omitted", () => {
    const config = makeConfig({ runtimeProxyRequireAuth: false });
    testConfig = config;
    const req = new Request(
      "http://localhost:7830/v1/stt/stream?mimeType=audio/webm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handleSttStreamWs(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("returns 400 when auth is disabled but mimeType is missing", () => {
    const config = makeConfig({ runtimeProxyRequireAuth: false });
    testConfig = config;
    const req = new Request(
      "http://localhost:7830/v1/stt/stream?provider=deepgram",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = handleSttStreamWs(req, server);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(400);
  });

  test("passes sampleRate to socket data when provided", () => {
    const config = makeConfig();
    testConfig = config;
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${TEST_TOKEN}&provider=deepgram&mimeType=audio/webm&sampleRate=16000`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    handleSttStreamWs(req, server);

    expect(upgradedData<SttStreamSocketData>(server)).toMatchObject({
      provider: "deepgram",
      mimeType: "audio/webm",
      sampleRate: 16000,
    });
  });
});

// ---------------------------------------------------------------------------
// getSttStreamWebsocketHandlers — WS lifecycle tests
// ---------------------------------------------------------------------------

describe("getSttStreamWebsocketHandlers", () => {
  const makeSttWs = () =>
    createFakeDownstreamWs<SttStreamSocketData>({
      wsType: "stt-stream",
      provider: "deepgram",
      mimeType: "audio/webm",
    });

  test("open handler initializes pending messages buffer", () => {
    const ws = makeSttWs();

    // The open handler creates a WebSocket to upstream which will fail in test,
    // but pendingMessages should be initialized before that happens.
    try {
      openSttStreamWebsocket(ws as never);
    } catch {
      // WebSocket constructor may throw in test environment
    }

    expect(ws.data.pendingMessages).toBeDefined();
  });

  test("message handler buffers messages when upstream is not connected", () => {
    const ws = makeSttWs();
    ws.data.pendingMessages = [];

    messageSttStreamWebsocket(ws as never, "test-audio-frame");

    expect(ws.data.pendingMessages).toContain("test-audio-frame");
  });

  test("message handler closes connection on buffer overflow", () => {
    const ws = makeSttWs();
    ws.data.pendingMessages = new Array(100).fill("x"); // At MAX_PENDING_MESSAGES

    messageSttStreamWebsocket(ws as never, "overflow-frame");

    expect(ws.close).toHaveBeenCalledWith(1008, "Buffer overflow");
  });

  test("close handler cleans up pending messages and closes upstream", () => {
    const ws = makeSttWs();
    ws.data.pendingMessages = ["some-data"];

    const fakeUpstream = {
      readyState: WebSocket.OPEN,
      close: mock(() => {}),
    };
    ws.data.upstream = fakeUpstream as unknown as WebSocket;

    closeSttStreamWebsocket(ws as never, 1000, "normal");

    expect(ws.data.pendingMessages).toBeUndefined();
    expect(fakeUpstream.close).toHaveBeenCalledWith(1000, "normal");
  });

  test("close handler is safe when upstream is already closed", () => {
    const ws = makeSttWs();

    const fakeUpstream = {
      readyState: WebSocket.CLOSED,
      close: mock(() => {}),
    };
    ws.data.upstream = fakeUpstream as unknown as WebSocket;

    closeSttStreamWebsocket(ws as never, 1000, "normal");

    expect(fakeUpstream.close).not.toHaveBeenCalled();
  });
});

/**
 * Dictation carries JSON transcript and lifecycle frames, each self-contained.
 * A dropped one costs a fragment, not the session, so the desktop stream's
 * teardown must not reach this route: the usual trigger is a runtime frame
 * landing just after the browser socket closed.
 */
describe("a dropped downstream frame does not end a dictation session", () => {
  let runtime: FakeRuntime;
  afterEach(() => {
    runtime?.server.stop(true);
  });

  const makeViewerWs = (sendStatus?: number) => {
    testConfig = makeConfig({
      assistantRuntimeBaseUrl: `http://127.0.0.1:${runtime.server.port}`,
    });
    return createFakeDownstreamWs<SttStreamSocketData>(
      {
        wsType: "stt-stream",
        mimeType: "audio/webm",
      },
      { sendStatus },
    );
  };

  test("keeps both sides open when a send is dropped", async () => {
    runtime = startFakeRuntime('{"type":"transcript","text":"hello"}');
    const ws = makeViewerWs(0);

    openSttStreamWebsocket(ws as never);
    await waitFor(() => ws.sent.length > 0);
    await settle();

    expect(ws.closes).toEqual([]);
    expect(ws.data.upstream!.readyState).toBe(WebSocket.OPEN);
  });

  test("does not treat an empty frame as a dropped one", async () => {
    runtime = startFakeRuntime("");
    const ws = makeViewerWs(0);

    openSttStreamWebsocket(ws as never);
    await waitFor(() => ws.sent.length > 0);
    await settle();

    expect(ws.closes).toEqual([]);
  });
});

/**
 * The regression guard for the watch stream's guardian pin.
 *
 * `/v1/watch/stream` opts into `guardian-pin` because it reads the owner's
 * screen. Dictation is the user's own words going to a transcriber and back,
 * so it takes any valid actor, and the shared authorization the two routes
 * share must not quietly acquire the pin on this one's behalf.
 *
 * The mock at the top of this file binds the guardian to a principal none of
 * these tokens carry, so a pin appearing here would turn every upgrade into a
 * 403 and this describe into a wall of failures.
 */
describe("dictation is not a guardian-only surface", () => {
  test("admits an actor who is not the bound guardian", async () => {
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${mintEdgeToken("some-other-actor")}&mimeType=audio/webm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();

    expect(handleSttStreamWs(req, server)).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("never consults the guardian binding at all", async () => {
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${mintEdgeToken("some-other-actor")}&mimeType=audio/webm`,
      { headers: { upgrade: "websocket" } },
    );

    handleSttStreamWs(req, makeFakeServer());

    expect(mockFindCadetGuardian).not.toHaveBeenCalled();
  });

  /**
   * The upgrade handler stays synchronous. Awaiting a binding lookup is what
   * would make it async, so the signature is itself evidence of the posture.
   */
  test("stays a synchronous upgrade handler", () => {
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?token=${mintEdgeToken()}&mimeType=audio/webm`,
      { headers: { upgrade: "websocket" } },
    );

    const result = handleSttStreamWs(req, makeFakeServer());

    expect(result).not.toBeInstanceOf(Promise);
  });
});

/**
 * The cloud path, where tunnel validated the browser's own token and
 * attested the caller to the bridge. There is no edge JWT on it, so requiring
 * one rejected every managed caller: the socket opened at tunnel and closed at
 * the loopback with an open failure, which the browser saw as a 1014.
 *
 * No guardian cross-check, unlike live voice and watch. Dictation admits any
 * valid actor, and tunnel only mints a token for a user with access to this
 * assistant, which is the same standing an actor token proves.
 */
describe("handleSttStreamWs: tunnel-attested managed auth", () => {
  const TUNNEL_USER_ID = "11111111-1111-1111-1111-111111111111";
  const TUNNEL_ORG_ID = "22222222-2222-2222-2222-222222222222";

  afterEach(() => {
    delete process.env.IS_CLOUD;
  });

  const managedUpgrade = ({
    bridgeProof = true,
    orgId = TUNNEL_ORG_ID as string | null,
    token,
    managed = true,
    tunnelBaseUrl,
  }: {
    bridgeProof?: boolean;
    orgId?: string | null;
    token?: string;
    managed?: boolean;
    tunnelBaseUrl?: string;
  }) => {
    if (managed) {
      process.env.IS_CLOUD = "true";
    } else {
      delete process.env.IS_CLOUD;
    }
    const headers = new Headers({
      upgrade: "websocket",
      "x-tunnel-user-id": TUNNEL_USER_ID,
      "x-tunnel-actor": "user",
    });
    if (orgId !== null) {
      headers.set("x-tunnel-org-id", orgId);
    }
    if (bridgeProof) {
      setTunnelBridgeAuthHeader(headers);
    }
    testConfig = makeConfig(tunnelBaseUrl ? { tunnelBaseUrl } : {});
    const query = token ? `&token=${token}` : "";
    const req = new Request(
      `http://localhost:7830/v1/stt/stream?mimeType=audio/pcm${query}`,
      { headers },
    );
    const server = makeFakeServer();
    return { res: handleSttStreamWs(req, server), server };
  };

  test("admits an attested caller with the bridge proof and no token", () => {
    const { res, server } = managedUpgrade({});

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  /**
   * A direct request to a reachable gateway can spoof the header names. It
   * cannot know the process-local bridge proof, which is what says the request
   * really arrived through this gateway's own loopback bridge.
   */
  test("ignores spoofed tunnel headers with no bridge proof", () => {
    const { res, server } = managedUpgrade({ bridgeProof: false });

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("falls through to the token path on an incomplete attestation", () => {
    const { res, server } = managedUpgrade({
      orgId: null,
      token: mintEdgeToken(),
    });

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  /** With no tunnel there is no bridge to have come through. */
  test("ignores tunnel headers on a gateway with no tunnel", () => {
    const { res, server } = managedUpgrade({ managed: false });

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  /** A locally hosted gateway with a tunnel takes the tunnel path like a cloud pod. */
  test("admits an attested caller on a locally hosted gateway with a tunnel", () => {
    const { res, server } = managedUpgrade({
      managed: false,
      tunnelBaseUrl: "https://tunnel.example.test",
    });

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("still ignores spoofed headers on a locally hosted gateway with a tunnel", () => {
    const { res, server } = managedUpgrade({
      managed: false,
      tunnelBaseUrl: "https://tunnel.example.test",
      bridgeProof: false,
    });

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });
});
