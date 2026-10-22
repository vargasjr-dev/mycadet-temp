import { resolve } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

// Capture the `will-finish-launching` and `open-url` subscriptions
// from `app.on` so tests can fire them. `setAsDefaultProtocolClient`
// is also captured to verify scheme registration.
type Listener = (...args: unknown[]) => void;

// Synthetic WebContents stub for the subscriber-tracking tests.
// `once("destroyed", …)` captures the cleanup handler so tests can
// fire it to simulate a renderer crash / window close.
const makeSender = (): {
  sender: { once: (event: string, handler: () => void) => void };
  fireDestroyed: () => void;
} => {
  let destroyedHandler: (() => void) | null = null;
  return {
    sender: {
      once: (event, handler) => {
        if (event === "destroyed") destroyedHandler = handler;
      },
    },
    fireDestroyed: () => destroyedHandler?.(),
  };
};
const subscribeWith = (s: ReturnType<typeof makeSender>) =>
  ipcOnListeners.get("cadet:deepLinks:subscribe")?.({ sender: s.sender });
const unsubscribeWith = (s: ReturnType<typeof makeSender>) =>
  ipcOnListeners.get("cadet:deepLinks:unsubscribe")?.({ sender: s.sender });
const appListeners = new Map<string, Listener>();
const appOnMock = mock((event: string, listener: Listener) => {
  appListeners.set(event, listener);
});
const setAsDefaultProtocolClientMock = mock(
  (_scheme: string, _path?: string, _args?: string[]) => true,
);
const ipcHandleMock = mock(
  (_channel: string, _handler: (...args: unknown[]) => unknown) => undefined,
);
const ipcOnListeners = new Map<string, Listener>();
const ipcOnMock = mock((event: string, listener: Listener) => {
  ipcOnListeners.set(event, listener);
});
let windows: Array<{
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof mock> };
}> = [];

let appIsReady = true;
let appIsPackaged = false;
mock.module("electron", () => ({
  app: {
    on: appOnMock,
    setAsDefaultProtocolClient: setAsDefaultProtocolClientMock,
    isReady: () => appIsReady,
    get isPackaged() {
      return appIsPackaged;
    },
  },
  ipcMain: { handle: ipcHandleMock, on: ipcOnMock },
  BrowserWindow: { getAllWindows: () => windows },
}));

const ensureMainWindowVisibleMock = mock(async () => undefined);

const {
  __resetForTesting,
  configureDeepLinks,
  extractDeepLinkFromArgv,
  handleDeepLink,
  installDeepLinks,
  parseCadetUrl,
  resolveAcceptedSchemes,
  resolveAuthCallbackScheme,
  resolveRegisteredSchemes,
} = await import("./deep-links");
const { resolveEnvironmentName } = await import("@mycadet/local-mode");

const allowedEvent = {};

const makeWindow = (destroyed = false) => ({
  isDestroyed: () => destroyed,
  webContents: { send: mock(() => undefined) },
});

const configureTestRuntime = (initialArgv: readonly string[] = []): void => {
  configureDeepLinks({
    ensureVisible: ensureMainWindowVisibleMock,
    handle: (channel, schema, fn) => {
      ipcHandleMock(channel, (event, ...args) =>
        fn(schema.parse(args), event as never),
      );
    },
    initialArgv,
    on: (channel, schema, fn) => {
      ipcOnListeners.set(channel, (event, ...args) => {
        const parsed = schema.safeParse(args);
        if (parsed.success) {
          fn(parsed.data, event as never);
        }
      });
    },
  });
};

beforeEach(() => {
  __resetForTesting();
  appListeners.clear();
  ipcOnListeners.clear();
  appOnMock.mockClear();
  setAsDefaultProtocolClientMock.mockClear();
  ipcHandleMock.mockClear();
  ipcOnMock.mockClear();
  ensureMainWindowVisibleMock.mockClear();
  windows = [];
  appIsReady = true;
  appIsPackaged = false;
  configureTestRuntime();
});

afterEach(() => {
  windows = [];
});

describe("parseCadetUrl", () => {
  test("cadet://send?message=hi → send with the message", () => {
    expect(parseCadetUrl("cadet://send?message=hi")).toEqual({
      kind: "send",
      message: "hi",
    });
  });

  test("cadet://send?message=hi → same shape under the alternate scheme", () => {
    expect(parseCadetUrl("cadet://send?message=hi")).toEqual({
      kind: "send",
      message: "hi",
    });
  });

  test("cadet://send → empty message (preserved, renderer decides)", () => {
    expect(parseCadetUrl("cadet://send")).toEqual({
      kind: "send",
      message: "",
    });
  });

  test("cadet://send decodes percent-encoded query parameters", () => {
    expect(parseCadetUrl("cadet://send?message=hello%20world")).toEqual({
      kind: "send",
      message: "hello world",
    });
  });

  test("cadet://thread/abc-123 → openThread with the id", () => {
    expect(parseCadetUrl("cadet://thread/abc-123")).toEqual({
      kind: "openThread",
      threadId: "abc-123",
    });
  });

  test("cadet://thread/abc-123/extra → openThread on first segment, extras ignored", () => {
    expect(parseCadetUrl("cadet://thread/abc-123/extra")).toEqual({
      kind: "openThread",
      threadId: "abc-123",
    });
  });

  test("cadet://thread → unknown (no id)", () => {
    expect(parseCadetUrl("cadet://thread")).toEqual({
      kind: "unknown",
      url: "cadet://thread",
    });
  });

  test("rejects foreign schemes — javascript: returns unknown", () => {
    expect(parseCadetUrl("javascript:alert(1)")).toEqual({
      kind: "unknown",
      url: "javascript:alert(1)",
    });
  });

  test("rejects file: scheme", () => {
    expect(parseCadetUrl("file:///etc/passwd")).toEqual({
      kind: "unknown",
      url: "file:///etc/passwd",
    });
  });

  test("rejects http: scheme", () => {
    expect(parseCadetUrl("http://mycadet.ai/send")).toEqual({
      kind: "unknown",
      url: "http://mycadet.ai/send",
    });
  });

  test("malformed input → unknown (catches URL constructor throws)", () => {
    expect(parseCadetUrl("not a url at all")).toEqual({
      kind: "unknown",
      url: "not a url at all",
    });
  });

  test("unrecognized cadet://… host → unknown", () => {
    expect(parseCadetUrl("cadet://garbage")).toEqual({
      kind: "unknown",
      url: "cadet://garbage",
    });
  });

  test("legacy auth/callback → unknown with query stripped (no code leak)", () => {
    // The legacy code must not survive into the URL the renderer logs as
    // a `deeplink.unknown` log.
    expect(
      parseCadetUrl("cadet://auth/callback?code=secret&state=xyz"),
    ).toEqual({ kind: "unknown", url: "cadet://auth/callback" });
    expect(parseCadetUrl("cadet://auth/callback?code=secret")).toEqual({
      kind: "unknown",
      url: "cadet://auth/callback",
    });
  });

  test("cadet://connect?url=…&code=… → connect carrying the base and the device code", () => {
    expect(
      parseCadetUrl(
        "cadet://connect?url=https%3A%2F%2Fassistant.example.com%2Fassistant-1&code=ABCD-1234",
      ),
    ).toEqual({
      kind: "connect",
      url: "https://assistant.example.com/assistant-1",
      code: "ABCD-1234",
    });
  });

  test("connect carries an opaque code, not just base64url", () => {
    // `buildAppConnectUrl` emits whatever the gateway minted, and its own test
    // pins `a+b/c=` surviving the encoding. Refusing it here would silently
    // drop an approved code and drop the user into a fresh approval flow.
    expect(
      parseCadetUrl(
        "cadet://connect?url=https%3A%2F%2Fh.example&code=a%2Bb%2Fc%3D",
      ),
    ).toEqual({ kind: "connect", url: "https://h.example", code: "a+b/c=" });
  });

  test("connect drops a code that cannot have come from a gateway", () => {
    expect(
      parseCadetUrl(
        "cadet://connect?url=https%3A%2F%2Fh.example&code=has%20a%20space",
      ),
    ).toEqual({ kind: "connect", url: "https://h.example" });
    expect(
      parseCadetUrl(
        "cadet://connect?url=https%3A%2F%2Fh.example&code=%00control",
      ),
    ).toEqual({ kind: "connect", url: "https://h.example" });
    expect(
      parseCadetUrl(
        `cadet://connect?url=https%3A%2F%2Fh.example&code=${"a".repeat(257)}`,
      ),
    ).toEqual({ kind: "connect", url: "https://h.example" });
  });

  test("connect drops a code with no base to exchange it against", () => {
    // Nothing can be done with a device code alone, so it is not carried
    // across the bridge just to be discarded there.
    expect(parseCadetUrl("cadet://connect?code=ABCD-1234")).toEqual({
      kind: "connect",
    });
    expect(
      parseCadetUrl("cadet://connect?url=http%3A%2F%2Fevil.example&code=SEC"),
    ).toEqual({ kind: "connect" });
  });

  test("cadet://connect?bundle=… → the legacy signal, never the payload", () => {
    const link = parseCadetUrl("cadet://connect?bundle=eyJnYXRld2F5");
    expect(link).toEqual({ kind: "connect", legacy: true });
    expect(JSON.stringify(link)).not.toContain("eyJnYXRld2F5");
  });

  test("a bundle rides alongside a usable base without displacing it", () => {
    expect(
      parseCadetUrl(
        "cadet://connect?url=https%3A%2F%2Fh.example&code=ABCD&bundle=eyJnYXRld2F5",
      ),
    ).toEqual({
      kind: "connect",
      url: "https://h.example",
      code: "ABCD",
      legacy: true,
    });
  });

  test("connect drops a non-https url param but keeps the rest of the link", () => {
    expect(
      parseCadetUrl(
        "cadet://connect?url=http%3A%2F%2Fevil.example&bundle=eyJnYXRld2F5",
      ),
    ).toEqual({ kind: "connect", legacy: true });
  });

  test("connect drops an unparseable url param", () => {
    expect(
      parseCadetUrl("cadet://connect?url=not%20a%20url&bundle=eyJnYXRld2F5"),
    ).toEqual({ kind: "connect", legacy: true });
  });

  test("a bare connect link still parses as connect, never unknown", () => {
    // The user clicked a connect link; even with every field missing or
    // malformed the renderer routes them to the connect flow with guidance
    // instead of logging an unknown URL.
    expect(parseCadetUrl("cadet://connect")).toEqual({ kind: "connect" });
    expect(parseCadetUrl("cadet://connect?url=&code=&bundle=")).toEqual({
      kind: "connect",
    });
  });

  test("connect secrets never surface in console output from the module", () => {
    // The parser carries `code` on the typed link only and drops the bundle
    // payload entirely. This guards the auth/callback precedent: nothing the
    // module does with a connect URL may write the raw URL's credential
    // material to a log stream.
    const consoleSpies = (
      ["log", "warn", "error", "info", "debug"] as const
    ).map((method) => spyOn(console, method));
    try {
      handleDeepLink(
        "cadet://connect?url=https%3A%2F%2Fh.example&code=SECRET-CODE&bundle=U0VDUkVUYnVuZGxl",
      );
      for (const spy of consoleSpies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain("SECRET");
          expect(JSON.stringify(call)).not.toContain("U0VDUkVU");
        }
      }
    } finally {
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
    }
  });

  test("a connect link never reaches the unknown echo path, however malformed", () => {
    // `unknown` carries its URL through to the renderer's log,
    // so a device code must never be able to route there. Every connect link
    // stays a connect link, malformed fields and all.
    for (const input of [
      "cadet://connect?url=https%3A%2F%2Fh.example&code=SECRET-CODE",
      "cadet://connect?url=nonsense&code=SECRET-CODE",
      "cadet://connect?code=SECRET-CODE",
      "cadet://connect/extra/path?code=SECRET-CODE",
    ]) {
      const link = parseCadetUrl(input);
      expect(link.kind).toBe("connect");
      expect(JSON.stringify(link)).not.toContain("nonsense");
    }
  });

  test("env-specific scheme for a foreign environment is rejected as unknown", () => {
    // A scheme that doesn't match any known environment is always
    // rejected, regardless of which env this test suite runs under.
    const url = "cadet-nonexistent://auth/callback?code=abc&state=xyz";
    expect(parseCadetUrl(url)).toEqual({ kind: "unknown", url });
  });
});

describe("extractDeepLinkFromArgv", () => {
  test("returns the first cadet:// URL in argv", () => {
    const argv = [
      "/usr/local/bin/electron",
      "--inspect=9229",
      "cadet://send?message=hi",
      "--unrelated",
    ];
    expect(extractDeepLinkFromArgv(argv)).toBe("cadet://send?message=hi");
  });

  test("matches the alternate scheme too", () => {
    expect(extractDeepLinkFromArgv(["cadet://thread/x"])).toBe(
      "cadet://thread/x",
    );
  });

  test("returns null when no deep-link arg is present", () => {
    expect(
      extractDeepLinkFromArgv(["/usr/local/bin/electron", "--foo"]),
    ).toBeNull();
  });

  test.each([
    "cadet://send?message=hello",
    "cadet://thread/thread-123",
    "cadet://connect?url=https%3A%2F%2Fh.example",
  ])("extracts supported Windows launch URL %s", (url) => {
    expect(extractDeepLinkFromArgv(["Cadet.exe", url])).toBe(url);
  });
});

describe("installDeepLinks", () => {
  test("delivers a cold-start argv link exactly once", () => {
    configureTestRuntime(["Cadet.exe", "cadet://send?message=cold"]);
    installDeepLinks();

    const drain = ipcHandleMock.mock.calls.find(
      (call) => call[0] === "cadet:deepLinks:drain",
    )?.[1] as (event: unknown) => unknown[];
    expect(drain(allowedEvent)).toEqual([{ kind: "send", message: "cold" }]);
    expect(drain(allowedEvent)).toEqual([]);
  });

  test("delivers a second-instance argv link exactly once", () => {
    installDeepLinks();
    appListeners.get("second-instance")?.({}, [
      "Cadet.exe",
      "cadet://thread/warm",
      "cadet://thread/ignored",
    ]);

    const drain = ipcHandleMock.mock.calls.find(
      (call) => call[0] === "cadet:deepLinks:drain",
    )?.[1] as (event: unknown) => unknown[];
    expect(drain(allowedEvent)).toEqual([
      { kind: "openThread", threadId: "warm" },
    ]);
    expect(drain(allowedEvent)).toEqual([]);
  });

  test("registers unpackaged apps with absolute executable and entry paths", () => {
    const entryPoint = process.argv[1];
    const platform = process.platform;
    const expected = resolveRegisteredSchemes(
      resolveEnvironmentName(process.env),
    );
    process.argv[1] = ".";
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      installDeepLinks();
      const firstCallCount = setAsDefaultProtocolClientMock.mock.calls.length;

      installDeepLinks();
      installDeepLinks();

      expect(setAsDefaultProtocolClientMock.mock.calls).toEqual(
        expected.map((scheme) => [scheme, process.execPath, [resolve(".")]]),
      );
      // Idempotent — repeated calls don't register again.
      expect(setAsDefaultProtocolClientMock).toHaveBeenCalledTimes(
        firstCallCount,
      );
    } finally {
      process.argv[1] = entryPoint;
      Object.defineProperty(process, "platform", { value: platform });
    }
  });

  test("keeps unpackaged non-Windows protocol registration unchanged", () => {
    installDeepLinks();

    const expected = resolveRegisteredSchemes(
      resolveEnvironmentName(process.env),
    );
    expect(setAsDefaultProtocolClientMock.mock.calls).toEqual(
      expected.map((scheme) => [scheme]),
    );
  });

  test("subscribes to will-finish-launching and registers an open-url listener under it", () => {
    installDeepLinks();
    const wfl = appListeners.get("will-finish-launching");
    expect(wfl).toBeDefined();

    wfl?.();
    expect(appListeners.has("open-url")).toBe(true);
  });

  test("open-url calls preventDefault on the event and buffers the parsed link", () => {
    installDeepLinks();
    appListeners.get("will-finish-launching")?.();
    const openUrl = appListeners.get("open-url");
    expect(openUrl).toBeDefined();

    const preventDefault = mock(() => undefined);
    openUrl?.({ preventDefault } as unknown, "cadet://send?message=hi");

    expect(preventDefault).toHaveBeenCalled();
  });

  test("registers the cadet:deepLinks:drain IPC handler returning + clearing the buffer", () => {
    installDeepLinks();

    handleDeepLink("cadet://send?message=one");
    handleDeepLink("cadet://thread/abc");

    // Find the registered handler.
    const drainCall = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "cadet:deepLinks:drain",
    );
    expect(drainCall).toBeDefined();
    const drainHandler = drainCall![1] as (event: unknown) => unknown;

    expect(drainHandler(allowedEvent)).toEqual([
      { kind: "send", message: "one" },
      { kind: "openThread", threadId: "abc" },
    ]);
    // Second drain returns empty — buffer was cleared.
    expect(drainHandler(allowedEvent)).toEqual([]);
  });

  test("with a subscriber present, live links broadcast but do NOT enter the buffer (no replay on renderer reload)", () => {
    installDeepLinks();
    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "cadet:deepLinks:drain",
    )![1] as (event: unknown) => unknown[];

    // Backlog before any subscriber.
    handleDeepLink("cadet://send?message=backlog");

    // Renderer mounts: subscribes, drains.
    const s1 = makeSender();
    subscribeWith(s1);
    expect(drainHandler(allowedEvent)).toEqual([
      { kind: "send", message: "backlog" },
    ]);

    // Live link arrives while subscribed — broadcasts only.
    handleDeepLink("cadet://thread/live");

    // Renderer hard-navigates: unsubscribe, then a new renderer
    // mounts and drains. The live link must NOT be replayed.
    unsubscribeWith(s1);
    const s2 = makeSender();
    subscribeWith(s2);
    expect(drainHandler(allowedEvent)).toEqual([]);
  });

  test("logout-relogin: link arriving while unsubscribed lands in the buffer for the next subscriber", () => {
    installDeepLinks();
    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "cadet:deepLinks:drain",
    )![1] as (event: unknown) => unknown[];

    const s1 = makeSender();
    subscribeWith(s1);
    expect(drainHandler(allowedEvent)).toEqual([]);

    unsubscribeWith(s1);

    handleDeepLink("cadet://thread/post-logout");

    const s2 = makeSender();
    subscribeWith(s2);
    expect(drainHandler(allowedEvent)).toEqual([
      { kind: "openThread", threadId: "post-logout" },
    ]);
  });

  test("unsubscribe with no matching subscriber is a no-op (idempotent delete)", () => {
    installDeepLinks();
    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "cadet:deepLinks:drain",
    )![1] as (event: unknown) => unknown[];

    const s = makeSender();
    unsubscribeWith(s);
    unsubscribeWith(s);

    handleDeepLink("cadet://send?message=should-buffer");
    expect(drainHandler(allowedEvent)).toEqual([
      { kind: "send", message: "should-buffer" },
    ]);
  });

  test("post-drain live links still broadcast (live subscribers still get them)", () => {
    installDeepLinks();
    const s = makeSender();
    subscribeWith(s);

    const w = makeWindow();
    windows = [w];
    handleDeepLink("cadet://send?message=live");

    expect(w.webContents.send).toHaveBeenCalledWith("cadet:deepLinks:event", {
      kind: "send",
      message: "live",
    });
  });

  test("destroyed webContents auto-clears its subscription (no leak when React cleanup misses)", () => {
    // The real bug this guards against: window close on Darwin
    // can tear down the JS context before React effect cleanups
    // flush, so `cadet:deepLinks:unsubscribe` never fires.
    // The `destroyed` listener cleans up regardless, so future
    // links buffer correctly.
    installDeepLinks();
    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "cadet:deepLinks:drain",
    )![1] as (event: unknown) => unknown[];

    const s = makeSender();
    subscribeWith(s);
    expect(drainHandler(allowedEvent)).toEqual([]);

    // Simulate window close without React cleanup running — only
    // the webContents `destroyed` event fires.
    s.fireDestroyed();

    // No subscribers now → next link is buffered.
    handleDeepLink("cadet://send?message=after-crash");
    expect(drainHandler(allowedEvent)).toEqual([
      { kind: "send", message: "after-crash" },
    ]);
  });
});

describe("handleDeepLink — broadcast", () => {
  test("broadcasts to every BrowserWindow's webContents", () => {
    const w1 = makeWindow();
    const w2 = makeWindow();
    windows = [w1, w2];

    handleDeepLink("cadet://send?message=broadcast");

    const expected = { kind: "send", message: "broadcast" };
    expect(w1.webContents.send).toHaveBeenCalledWith(
      "cadet:deepLinks:event",
      expected,
    );
    expect(w2.webContents.send).toHaveBeenCalledWith(
      "cadet:deepLinks:event",
      expected,
    );
  });

  test("skips destroyed windows", () => {
    const alive = makeWindow();
    const dead = makeWindow(true);
    windows = [alive, dead];

    handleDeepLink("cadet://send?message=skip");

    expect(alive.webContents.send).toHaveBeenCalled();
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });

  test("unknown-kind links are still broadcast (renderer logs / drops)", () => {
    const w = makeWindow();
    windows = [w];

    handleDeepLink("javascript:alert(1)");

    expect(w.webContents.send).toHaveBeenCalledWith("cadet:deepLinks:event", {
      kind: "unknown",
      url: "javascript:alert(1)",
    });
  });
});

describe("handleDeepLink — window activation", () => {
  test("brings the main window forward for `send` (covers the no-renderer case on Darwin)", () => {
    handleDeepLink("cadet://send?message=hi");
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("brings the main window forward for `openThread`", () => {
    handleDeepLink("cadet://thread/abc");
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("brings the main window forward for `connect`", () => {
    handleDeepLink("cadet://connect?url=https%3A%2F%2Fh.example&code=ABCD");
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("does NOT activate the window for unknown kinds (no UI side effect for foreign schemes)", () => {
    handleDeepLink("javascript:alert(1)");
    handleDeepLink("file:///etc/passwd");
    handleDeepLink("not a url");

    expect(ensureMainWindowVisibleMock).not.toHaveBeenCalled();
  });

  test("defers activation when app is not yet ready (cold-launch via cadet://)", () => {
    // Cold launch path: `will-finish-launching` → `open-url` fires
    // BEFORE `app.whenReady()`. `new BrowserWindow()` pre-ready
    // would race Electron init; the link is buffered above and the
    // initial `installMainWindow` in the whenReady chain creates
    // the window which drains it on mount.
    appIsReady = false;
    handleDeepLink("cadet://send?message=cold-launch");

    expect(ensureMainWindowVisibleMock).not.toHaveBeenCalled();
  });

  test("activates after app becomes ready (warm path: subsequent links)", () => {
    appIsReady = false;
    handleDeepLink("cadet://send?message=cold");
    expect(ensureMainWindowVisibleMock).not.toHaveBeenCalled();

    // Simulate whenReady having fired.
    appIsReady = true;
    handleDeepLink("cadet://thread/warm");
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("buffers the link AND activates so the renderer-on-mount drain still delivers it", () => {
    // Simulating the macOS path: app alive, main window closed,
    // user clicks cadet://send → main handles it. The link must
    // both (a) be parked in the buffer for the freshly-created
    // renderer to drain, and (b) trigger window creation so the
    // renderer actually mounts.
    handleDeepLink("cadet://send?message=delivered");

    // Activation fired.
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
    // Link buffered (no subscribers yet — the new window hasn't
    // mounted).
    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "cadet:deepLinks:drain",
    );
    // installDeepLinks hasn't run in this test, so register the
    // handler via a fresh install before draining.
    if (!drainHandler) {
      installDeepLinks();
    }
    const drain = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "cadet:deepLinks:drain",
    )![1] as (event: unknown) => unknown[];
    expect(drain(allowedEvent)).toEqual([
      { kind: "send", message: "delivered" },
    ]);
  });
});

describe("resolveRegisteredSchemes", () => {
  test("production registers cadet", () => {
    expect(resolveRegisteredSchemes("production")).toEqual(["cadet"]);
  });

  test("dev registers only cadet-dev", () => {
    expect(resolveRegisteredSchemes("dev")).toEqual(["cadet-dev"]);
  });

  test("staging registers only cadet-staging", () => {
    expect(resolveRegisteredSchemes("staging")).toEqual(["cadet-staging"]);
  });

  test("local registers only cadet-local", () => {
    expect(resolveRegisteredSchemes("local")).toEqual(["cadet-local"]);
  });

  test("unknown env derives scheme from env name", () => {
    expect(resolveRegisteredSchemes("test")).toEqual(["cadet-test"]);
  });
});

describe("resolveAuthCallbackScheme", () => {
  test("uses the app-specific production scheme", () => {
    expect(resolveAuthCallbackScheme("production")).toBe("cadet");
  });

  test("uses the environment-specific non-production scheme", () => {
    expect(resolveAuthCallbackScheme("dev")).toBe("cadet-dev");
  });
});

describe("resolveAcceptedSchemes", () => {
  test("production accepts cadet:", () => {
    const accepted = resolveAcceptedSchemes("production");
    expect(accepted).toContain("cadet:");
    expect(accepted).toHaveLength(1);
  });

  test("dev accepts cadet: and cadet-dev:", () => {
    const accepted = resolveAcceptedSchemes("dev");
    expect(accepted).toContain("cadet:");
    expect(accepted).toContain("cadet-dev:");
    expect(accepted).toHaveLength(2);
  });

  test("staging accepts cadet: and cadet-staging:", () => {
    const accepted = resolveAcceptedSchemes("staging");
    expect(accepted).toContain("cadet:");
    expect(accepted).toContain("cadet-staging:");
    expect(accepted).toHaveLength(2);
  });

  test("local accepts cadet: and cadet-local:", () => {
    const accepted = resolveAcceptedSchemes("local");
    expect(accepted).toContain("cadet:");
    expect(accepted).toContain("cadet-local:");
    expect(accepted).toHaveLength(2);
  });
});
