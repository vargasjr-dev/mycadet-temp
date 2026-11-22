import { afterEach, describe, test, expect, mock } from "bun:test";
import type { WatchStreamSocketData } from "../http/routes/watch-stream-websocket.js";
import {
  GUARDIAN_PRINCIPAL,
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

// The pin itself is covered in `guardian-pin.test.ts`; the binding is mocked
// here only so the route can be shown to wire it in.
mock.module("../auth/guardian-bootstrap.js", () => ({
  findCadetGuardian: async () => ({ principalId: GUARDIAN_PRINCIPAL }),
}));

let testConfig = makeConfig();
mock.module("../config.js", () => ({
  getConfig: () => testConfig,
}));

const {
  closeWatchStreamWebsocket,
  handleWatchStreamWs,
  messageWatchStreamWebsocket,
  openWatchStreamWebsocket,
} = await import("../http/routes/watch-stream-websocket.js");

// ---------------------------------------------------------------------------
// handleWatchStreamWs: upgrade handler tests
// ---------------------------------------------------------------------------

describe("handleWatchStreamWs", () => {
  const TEST_TOKEN = mintEdgeToken();

  test("upgrades when the token query parameter is valid", async () => {
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&sampleRate=16000`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handleWatchStreamWs(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
    expect(upgradedData<WatchStreamSocketData>(server)).toMatchObject({
      wsType: "watch-stream",
      mimeType: "audio/pcm",
      sampleRate: 16000,
    });
  });

  test("upgrades when the Authorization header is valid", async () => {
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?mimeType=audio/pcm",
      {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
      },
    );
    const server = makeFakeServer();

    expect(await handleWatchStreamWs(req, server)).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("carries an explicit conversation and host client through", async () => {
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&conversationId=conv-1&clientId=host-1`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    await handleWatchStreamWs(req, server);

    expect(upgradedData<WatchStreamSocketData>(server)).toMatchObject({
      conversationId: "conv-1",
      clientId: "host-1",
    });
  });

  /**
   * A session with no conversation named is the companion surface's Watch,
   * which starts a session rather than joining a thread. Blank has to read the
   * same as absent, or the runtime would be handed an empty id to file against.
   */
  test("reads blank optional parameters as absent", async () => {
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&conversationId=%20&clientId=`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    await handleWatchStreamWs(req, server);

    const data = upgradedData<WatchStreamSocketData>(server);
    expect(data.conversationId).toBeUndefined();
    expect(data.clientId).toBeUndefined();
  });

  /**
   * The companion's pick. The frame the client draws around what it picked
   * is only honest if the runtime reads the same thing, and this proxy is
   * the one place between them.
   */
  test("carries the capture target through to the runtime", async () => {
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&captureWindowId=4242`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    await handleWatchStreamWs(req, server);

    const data = upgradedData<WatchStreamSocketData>(server);
    expect(data.captureWindowId).toBe(4242);
    expect(data.captureDisplayId).toBeUndefined();
  });

  test("reads a blank capture id as absent", async () => {
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&captureDisplayId=`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    await handleWatchStreamWs(req, server);
    expect(
      upgradedData<WatchStreamSocketData>(server).captureDisplayId,
    ).toBeUndefined();
  });

  test("refuses a capture id that is not a whole number", async () => {
    for (const bad of ["-1", "1.5", "abc", "0x10"]) {
      const req = new Request(
        `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&captureWindowId=${bad}`,
        { headers: { upgrade: "websocket" } },
      );
      const res = await handleWatchStreamWs(req, makeFakeServer());
      expect(res?.status).toBe(400);
    }
  });

  test("refuses a display and a window named together", async () => {
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&captureDisplayId=1&captureWindowId=2`,
      { headers: { upgrade: "websocket" } },
    );
    const res = await handleWatchStreamWs(req, makeFakeServer());
    expect(res?.status).toBe(400);
  });

  test("returns 401 when no token is provided", async () => {
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?mimeType=audio/pcm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handleWatchStreamWs(req, server);

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 401 when the token is invalid", async () => {
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?token=bad-token&mimeType=audio/pcm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handleWatchStreamWs(req, server);

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  /**
   * The client-facing half of the proxy takes actors and nothing else. A
   * service credential reaching it would open a user's microphone stream on a
   * token minted for machine to machine traffic.
   */
  test("returns 401 for a service token, which has no actor principal", async () => {
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${mintServiceEdgeToken()}&mimeType=audio/pcm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handleWatchStreamWs(req, server);

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 400 when mimeType is missing", async () => {
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handleWatchStreamWs(req, server);

    expect(res!.status).toBe(400);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 426 when the request is not a WebSocket upgrade", async () => {
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm`,
    );
    const server = makeFakeServer();
    const res = await handleWatchStreamWs(req, server);

    expect(res!.status).toBe(426);
  });

  test("returns 500 when the Bun upgrade fails", async () => {
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer(false);
    const res = await handleWatchStreamWs(req, server);

    expect(res!.status).toBe(500);
  });

  test("allows an unauthenticated upgrade when auth is disabled (dev bypass)", async () => {
    testConfig = makeConfig({ runtimeProxyRequireAuth: false });
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?mimeType=audio/pcm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();

    expect(await handleWatchStreamWs(req, server)).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("still requires mimeType when auth is disabled", async () => {
    testConfig = makeConfig({ runtimeProxyRequireAuth: false });
    const req = new Request("http://localhost:7830/v1/watch/stream", {
      headers: { upgrade: "websocket" },
    });
    const server = makeFakeServer();
    const res = await handleWatchStreamWs(req, server);

    expect(res!.status).toBe(400);
  });

  /**
   * Watch reads the owner's screen, and the proxy replaces the caller's
   * identity upstream, so the route has to opt into the guardian pin.
   */
  test("refuses a non-guardian actor", async () => {
    testConfig = makeConfig();
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${mintEdgeToken("someone-else")}&mimeType=audio/pcm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handleWatchStreamWs(req, server);

    expect(res!.status).toBe(403);
    expect(server.upgrade).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getWatchStreamWebsocketHandlers: WS lifecycle tests
// ---------------------------------------------------------------------------

describe("getWatchStreamWebsocketHandlers", () => {
  const makeWatchWs = () =>
    createFakeDownstreamWs<WatchStreamSocketData>({
      wsType: "watch-stream",
      mimeType: "audio/pcm",
      sampleRate: 16000,
    });

  test("open initializes the pending message buffer", async () => {
    const ws = makeWatchWs();

    // Dialing upstream fails in a test process; the buffer is set up first.
    try {
      openWatchStreamWebsocket(ws as never);
    } catch {
      // The WebSocket constructor may throw here.
    }

    expect(ws.data.pendingMessages).toBeDefined();
  });

  /**
   * The client starts sending the moment its own socket opens, which is before
   * this proxy has an upstream to send to. The first fraction of a second of
   * narration is exactly the part a transcriber needs.
   */
  test("the capture target rides the upstream dial", async () => {
    const runtime = startFakeRuntime('{"type":"session_started"}');
    try {
      testConfig = makeConfig({
        assistantRuntimeBaseUrl: `http://127.0.0.1:${runtime.server.port}`,
      });
      const ws = createFakeDownstreamWs<WatchStreamSocketData>({
        wsType: "watch-stream",
        mimeType: "audio/pcm",
        captureWindowId: 4242,
      });

      openWatchStreamWebsocket(ws as never);
      await runtime.connected;

      // The socket data rides the upstream dial as scalar query params, so
      // the runtime reads the same capture target the client drew.
      const url = runtime.upgradeUrl()!;
      expect(url.searchParams.get("captureWindowId")).toBe("4242");
      expect(url.searchParams.has("captureDisplayId")).toBe(false);
    } finally {
      runtime.server.stop(true);
    }
  });

  test("message buffers frames that arrive before upstream connects", async () => {
    const ws = makeWatchWs();
    ws.data.pendingMessages = [];

    messageWatchStreamWebsocket(ws as never, "narration-frame");

    expect(ws.data.pendingMessages).toContain("narration-frame");
  });

  test("message closes the socket rather than buffering without bound", async () => {
    const ws = makeWatchWs();
    ws.data.pendingMessages = new Array(100).fill("x");

    messageWatchStreamWebsocket(ws as never, "overflow-frame");

    expect(ws.close).toHaveBeenCalledWith(1008, "Buffer overflow");
  });

  test("message forwards straight through once upstream is open", async () => {
    const ws = makeWatchWs();
    ws.data.pendingMessages = [];
    const upstream = {
      readyState: WebSocket.OPEN,
      send: mock(() => {}),
    };
    ws.data.upstream = upstream as unknown as WebSocket;

    messageWatchStreamWebsocket(ws as never, "narration-frame");

    expect(upstream.send).toHaveBeenCalledWith("narration-frame");
    expect(ws.data.pendingMessages).toEqual([]);
  });

  test("close releases the buffer and closes upstream with the same code", async () => {
    const ws = makeWatchWs();
    ws.data.pendingMessages = ["some-data"];
    const upstream = {
      readyState: WebSocket.OPEN,
      close: mock(() => {}),
    };
    ws.data.upstream = upstream as unknown as WebSocket;

    closeWatchStreamWebsocket(ws as never, 1000, "normal");

    expect(ws.data.pendingMessages).toBeUndefined();
    expect(upstream.close).toHaveBeenCalledWith(1000, "normal");
  });

  test("close is safe when upstream is already gone", async () => {
    const ws = makeWatchWs();
    const upstream = {
      readyState: WebSocket.CLOSED,
      close: mock(() => {}),
    };
    ws.data.upstream = upstream as unknown as WebSocket;

    closeWatchStreamWebsocket(ws as never, 1000, "normal");

    expect(upstream.close).not.toHaveBeenCalled();
  });
});

/**
 * Watch tears down on a dropped frame like the desktop stream does: a
 * narrated session that outruns its viewer is not worth continuing at a
 * loss. An empty frame is not a drop — Bun reports a byte count, so a
 * zero-byte write never reads as one.
 */
describe("a dropped downstream frame ends the watch session", () => {
  let runtime: FakeRuntime;
  afterEach(() => {
    runtime?.server.stop(true);
  });

  const makeViewerWs = (sendStatus?: number) => {
    testConfig = makeConfig({
      assistantRuntimeBaseUrl: `http://127.0.0.1:${runtime.server.port}`,
    });
    return createFakeDownstreamWs<WatchStreamSocketData>(
      {
        wsType: "watch-stream",
        mimeType: "audio/pcm",
      },
      { sendStatus },
    );
  };

  test("closes both sides when a downstream send is dropped", async () => {
    runtime = startFakeRuntime('{"type":"session_started"}');
    const ws = makeViewerWs(0);

    openWatchStreamWebsocket(ws as never);
    const upstreamClose = mock(ws.data.upstream!.close.bind(ws.data.upstream));
    ws.data.upstream!.close = upstreamClose;
    await waitFor(() => ws.closes.length > 0);

    expect(ws.closes[0]).toEqual({ code: 1011, reason: "Viewer too slow" });
    expect(upstreamClose).toHaveBeenCalledWith(1011, "Viewer too slow");
  });

  test("does not treat an empty frame as a dropped one", async () => {
    runtime = startFakeRuntime("");
    const ws = makeViewerWs(0);

    openWatchStreamWebsocket(ws as never);
    await waitFor(() => ws.sent.length > 0);
    await settle();

    expect(ws.closes).toEqual([]);
  });
});
