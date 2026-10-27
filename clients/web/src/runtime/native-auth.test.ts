import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

type StartAuthOptions = {
  baseURL: string;
  loginHint?: string;
  intent?: string;
  attribution?: Record<string, string>;
  postAuthDestination: string;
};

let nativePlatform = false;
let platform = "web";

const startAuth = mock(async (_options: StartAuthOptions) => ({
  sessionToken: "session-token",
}));
const readInstallReferrer = mock(
  async (): Promise<{ referrer?: string }> => ({}),
);

const nativePlugins: Record<string, unknown> = {
  NativeAuth: { startAuth, consumeRestoredAuth: async () => ({}) },
  InstallReferrer: { read: readInstallReferrer },
};

mock.module("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => nativePlatform,
    getPlatform: () => platform,
  },
  registerPlugin: (name: string) => nativePlugins[name] ?? {},
}));

// `completeNativeLogin` polls the session endpoint before navigating. Answer
// "authenticated" immediately so the native tests don't sit through the
// backoff or reach the network.
mock.module("@/lib/auth/allauth-client", () => ({
  getSession: async () => ({ ok: true, data: { user: { id: "user-1" } } }),
}));

const { resolveNativePostAuthDestination, startAuthFlow, startNativeLogin } =
  await import("./native-auth");
const { nativeAuthErrorDetail } =
  await import("@/domains/account/native-auth-error");
const { ONBOARDED_HATCH_AGE_MS } =
  await import("@/assistant/onboarded-assistant");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { routes } = await import("@/utils/routes");
const { NEW_ASSISTANT_PARAM } =
  await import("@/lib/navigation/onboarding-destination");

describe("resolveNativePostAuthDestination", () => {
  beforeEach(() => {
    sessionStorage.clear();
    useResolvedAssistantsStore.setState({ assistants: [] });
  });

  afterEach(() => {
    useResolvedAssistantsStore.setState({ assistants: [] });
  });

  test("native signup consents at the shell screen, returning to the funnel", () => {
    const destination = resolveNativePostAuthDestination(
      "signup",
      "/assistant/identity",
    );

    expect(destination).toBe(
      `/account/consent?returnTo=${encodeURIComponent(
        "/assistant/onboarding/research",
      )}`,
    );
  });

  test("native signup with no returnTo consents at the shell screen", () => {
    const destination = resolveNativePostAuthDestination("signup", null);

    expect(destination).toBe(
      `/account/consent?returnTo=${encodeURIComponent(
        "/assistant/onboarding/research",
      )}`,
    );
  });

  test("native signup skips privacy when the assistant is already onboarded", () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "asst-1",
          hatchedAt: new Date(
            Date.now() - ONBOARDED_HATCH_AGE_MS,
          ).toISOString(),
          isLocal: false,
          isCloudHosted: true,
          isPaired: false,
        },
      ],
    });

    const destination = resolveNativePostAuthDestination(
      "signup",
      "/assistant/identity",
    );

    expect(destination).toBe("/assistant/identity");
  });

  test("native login skips a research returnTo when the assistant is already onboarded", () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "asst-1",
          hatchedAt: new Date(
            Date.now() - ONBOARDED_HATCH_AGE_MS,
          ).toISOString(),
          isLocal: false,
          isCloudHosted: true,
          isPaired: false,
        },
      ],
    });

    expect(
      resolveNativePostAuthDestination("login", routes.onboarding.research),
    ).toBe(routes.assistant);
  });

  // The web funnel got this exemption in #41656; native post-auth is the same
  // decision and had none, so a returning user's deliberate new-assistant walk
  // was rewritten away.
  test("native login keeps a marked new-assistant returnTo", () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "asst-1",
          hatchedAt: new Date(
            Date.now() - ONBOARDED_HATCH_AGE_MS,
          ).toISOString(),
          isLocal: false,
          isCloudHosted: true,
          isPaired: false,
        },
      ],
    });
    const returnTo = `${routes.onboarding.research}?${NEW_ASSISTANT_PARAM}=1`;

    expect(resolveNativePostAuthDestination("login", returnTo)).toBe(returnTo);
  });
});

describe("startAuthFlow on Electron", () => {
  const windowWithBridge = window as { cadet?: unknown };
  const originalLocation = Object.getOwnPropertyDescriptor(window, "location");

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: "app://mycadet.ai/assistant/welcome" },
    });
  });

  afterEach(() => {
    delete windowWithBridge.cadet;
    useResolvedAssistantsStore.setState({ assistants: [] });
    if (originalLocation) {
      Object.defineProperty(window, "location", originalLocation);
    }
  });

  test("a bridge without auth.startOAuth rejects instead of falling into the loopback flow", async () => {
    windowWithBridge.cadet = { platform: "electron" };

    const error = await startAuthFlow("workos", "/account/provider/callback", {
      returnTo: "/assistant/identity",
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect(nativeAuthErrorDetail(error)).toBe("desktop_update_required");
  });

  test("a bridge with auth.startOAuth drives the in-app OAuth flow", async () => {
    const startOAuth = mock(() => Promise.resolve({ sessionToken: "" }));
    windowWithBridge.cadet = { platform: "electron", auth: { startOAuth } };

    await startAuthFlow("workos", "/account/provider/callback", {
      returnTo: "/assistant/identity",
      intent: "login",
    });

    expect(startOAuth).toHaveBeenCalledTimes(1);
    expect(startOAuth).toHaveBeenCalledWith({ intent: "login" });
  });

  test("a returning user skips the first-run funnel destination", async () => {
    const startOAuth = mock(() =>
      Promise.resolve({ sessionToken: "session-token" }),
    );
    windowWithBridge.cadet = {
      platform: "electron",
      auth: { startOAuth },
      menu: { setCloudSession: async () => {} },
    };
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "asst-1",
          hatchedAt: new Date(
            Date.now() - ONBOARDED_HATCH_AGE_MS,
          ).toISOString(),
          isLocal: false,
          isCloudHosted: true,
          isPaired: false,
        },
      ],
    });

    await startAuthFlow("workos", "/account/provider/callback", {
      returnTo: routes.onboarding.hosting,
      intent: "login",
    });

    expect(window.location.href).toBe(routes.assistant);
  });
});

describe("startAuthFlow attribution on native", () => {
  const INSTALL_REFERRER_KEY = "device:install_referrer";
  const originalLocation = Object.getOwnPropertyDescriptor(window, "location");

  /**
   * Swap in a plain `location`: happy-dom would try to navigate on the `href`
   * assignment that ends the flow, and a plain object lets the test read back
   * the destination that was chosen.
   */
  function setLocation(search: string): void {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        protocol: "https:",
        host: "mycadet.ai",
        search,
        href: "https://mycadet.ai/account/signup",
      },
    });
  }

  function lastStartAuthOptions(): StartAuthOptions {
    const options = startAuth.mock.calls.at(-1)?.[0];
    if (!options) {
      throw new Error("startAuth was never called");
    }
    return options;
  }

  async function runSignup(): Promise<void> {
    await startAuthFlow("workos", "/account/provider/callback", {
      intent: "signup",
      returnTo: "/assistant/identity",
    });
  }

  beforeEach(() => {
    nativePlatform = true;
    platform = "android";
    localStorage.clear();
    sessionStorage.clear();
    useResolvedAssistantsStore.setState({ assistants: [] });
    // Keep `completeNativeLogin`'s biometric branch out of the way; it is
    // opt-out, so an unset preference would reach the secure-storage plugin.
    localStorage.setItem("device:biometric_enabled", "false");
    mock.clearAllMocks();
    startAuth.mockResolvedValue({ sessionToken: "session-token" });
    readInstallReferrer.mockResolvedValue({});
    setLocation("");
  });

  afterEach(() => {
    nativePlatform = false;
    platform = "web";
    useResolvedAssistantsStore.setState({ assistants: [] });
  });

  afterAll(() => {
    if (originalLocation) {
      Object.defineProperty(window, "location", originalLocation);
    }
  });

  test("forwards the allowlisted URL params to the shell", async () => {
    setLocation("?utm_source=newsletter&utm_campaign=spring&not_a_param=x");

    await runSignup();

    expect(startAuth).toHaveBeenCalledTimes(1);
    expect(lastStartAuthOptions().attribution).toEqual({
      utm_source: "newsletter",
      utm_campaign: "spring",
    });
    // A live URL source short-circuits the install-referrer bridge entirely.
    expect(readInstallReferrer).not.toHaveBeenCalled();
  });

  test("captures and forwards the Play install referrer when the URL has none", async () => {
    readInstallReferrer.mockResolvedValueOnce({
      referrer: "utm_source=google-play&utm_medium=organic&anid=admob",
    });

    await runSignup();

    expect(readInstallReferrer).toHaveBeenCalledTimes(1);
    expect(lastStartAuthOptions().attribution).toEqual({
      utm_source: "google-play",
      utm_medium: "organic",
    });
  });

  test("omits attribution entirely when neither source has any", async () => {
    await runSignup();

    const options = lastStartAuthOptions();
    expect(Object.keys(options).sort()).toEqual([
      "baseURL",
      "intent",
      "postAuthDestination",
    ]);
    expect(options).toEqual({
      baseURL: "https://mycadet.ai",
      intent: "signup",
      postAuthDestination: `/account/consent?returnTo=${encodeURIComponent(
        "/assistant/onboarding/research",
      )}`,
    });
  });

  test("sends one source, never a merge of both", async () => {
    setLocation("?utm_source=newsletter");
    localStorage.setItem(
      INSTALL_REFERRER_KEY,
      "utm_source=google-play&utm_medium=organic&gclid=abc123",
    );

    await runSignup();

    // The cloud stores a row as one coherent source, so the stored
    // referrer's fields must not be spliced into the URL's.
    expect(lastStartAuthOptions().attribution).toEqual({
      utm_source: "newsletter",
    });
  });

  test("an explicit attribution option outranks both discovered sources", async () => {
    setLocation("?utm_source=newsletter");
    localStorage.setItem(INSTALL_REFERRER_KEY, "utm_source=google-play");

    await startAuthFlow("workos", "/account/provider/callback", {
      intent: "signup",
      returnTo: "/assistant/identity",
      attribution: { utm_source: "explicit" },
    });

    expect(lastStartAuthOptions().attribution).toEqual({
      utm_source: "explicit",
    });
  });

  test("spends the stored referrer once the session is real", async () => {
    localStorage.setItem(INSTALL_REFERRER_KEY, "utm_source=google-play");

    await runSignup();

    expect(lastStartAuthOptions().attribution).toEqual({
      utm_source: "google-play",
    });
    expect(localStorage.getItem(INSTALL_REFERRER_KEY)).toBe("");
    expect(window.location.href).toBe(
      `/account/consent?returnTo=${encodeURIComponent(
        "/assistant/onboarding/research",
      )}`,
    );
  });

  test("resolves attribution on the direct login entry too", async () => {
    // `login-page.tsx` calls `startNativeLogin` itself, and it is the entry an
    // unauthenticated fresh Play install actually reaches.
    setLocation("?utm_source=newsletter&not_a_param=x");

    await startNativeLogin({ returnTo: "/assistant/identity" });

    expect(lastStartAuthOptions().attribution).toEqual({
      utm_source: "newsletter",
    });
  });

  test("captures the install referrer on the direct login entry", async () => {
    readInstallReferrer.mockResolvedValueOnce({
      referrer: "utm_source=google-play&utm_medium=organic",
    });

    await startNativeLogin({ returnTo: "/assistant/identity" });

    expect(readInstallReferrer).toHaveBeenCalledTimes(1);
    expect(lastStartAuthOptions().attribution).toEqual({
      utm_source: "google-play",
      utm_medium: "organic",
    });
    expect(localStorage.getItem(INSTALL_REFERRER_KEY)).toBe("");
  });

  test("a login that captured no referrer leaves the next one retryable", async () => {
    // The shell answered nothing here, so this login had nothing to spend and
    // the next flow gets to ask again.
    await runSignup();
    expect(lastStartAuthOptions().attribution).toBeUndefined();
    expect(localStorage.getItem(INSTALL_REFERRER_KEY)).toBeNull();

    readInstallReferrer.mockResolvedValueOnce({
      referrer: "utm_source=google-play&utm_medium=organic",
    });
    await runSignup();

    expect(lastStartAuthOptions().attribution).toEqual({
      utm_source: "google-play",
      utm_medium: "organic",
    });
  });

  test("an iOS login records no spend", async () => {
    platform = "ios";

    await runSignup();

    expect(localStorage.getItem(INSTALL_REFERRER_KEY)).toBeNull();
  });

  test("leaves the stored referrer in place when native auth fails", async () => {
    localStorage.setItem(INSTALL_REFERRER_KEY, "utm_source=google-play");
    startAuth.mockRejectedValueOnce(
      Object.assign(new Error("auth failed"), { code: "AUTH_FAILED" }),
    );

    await expect(runSignup()).rejects.toThrow("auth failed");

    expect(localStorage.getItem(INSTALL_REFERRER_KEY)).toBe(
      "utm_source=google-play",
    );
  });

  test("leaves the stored referrer in place when the user cancels", async () => {
    localStorage.setItem(INSTALL_REFERRER_KEY, "utm_source=google-play");
    startAuth.mockRejectedValueOnce(
      Object.assign(new Error("cancelled"), { code: "USER_CANCELLED" }),
    );

    await runSignup();

    expect(localStorage.getItem(INSTALL_REFERRER_KEY)).toBe(
      "utm_source=google-play",
    );
  });
});
