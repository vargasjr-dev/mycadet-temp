import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  electronAppOverride,
  electronMock,
  recordedIpcHandlers,
  recordedIpcOnListeners,
} from "../test-setup";

// The handlers ride the shared registrar, whose ipcMain registrations the
// shared surface records; tests invoke the recorded wrappers directly.
const { protocol: allowedProtocol, host: allowedHost } =
  await import("./app-origin").then(({ resolveAllowedOrigin }) =>
    resolveAllowedOrigin(),
  );
const allowedEvent = {
  senderFrame: { origin: `${allowedProtocol}//${allowedHost}` },
};

// Capture the OAuth start URL so tests can read back the generated `state`.
let lastOpenedUrl = "";

// Capture legacy-cookie eviction calls.
const cookieRemoveCalls: Array<{ url: string; name: string }> = [];

// Capture the post-login app-refocus calls.
const refocus = { appFocusSteal: 0, ensureVisible: 0 };

// The cloud URL, browser hand-off, cookie eviction, and session store are
// the package's own dependencies now — mocked at their seams.
const store = { saved: [] as string[], clearCalls: 0 };

mock.module("electron", () =>
  electronMock({
    app: electronAppOverride({
      focus: () => {
        refocus.appFocusSteal += 1;
      },
    }),
    shell: {
      openExternal: (url: string) => {
        lastOpenedUrl = url;
        return Promise.resolve();
      },
    },
    session: {
      defaultSession: {
        cookies: {
          remove: (url: string, name: string) => {
            cookieRemoveCalls.push({ url, name });
            return Promise.resolve();
          },
        },
      },
    },
    net: {
      // Routed by URL: serves the real workos-pkce module's three network
      // legs (config discovery, WorkOS code exchange, session exchange) and
      // the legacy /accounts/native/exchange.
      fetch: (url: string) => {
        let body: unknown;
        if (url.includes("/_allauth/app/v1/config")) {
          body = {
            data: {
              socialaccount: {
                providers: [
                  {
                    id: "workos-oidc",
                    name: "WorkOS",
                    client_id: "client_um_test",
                    flows: ["provider_redirect", "provider_token"],
                  },
                ],
              },
            },
          };
        } else if (url.includes("/user_management/authenticate")) {
          body = { access_token: "access-token-abc", user: {} };
        } else if (url.includes("/_allauth/app/v1/auth/provider/token")) {
          body = { meta: { session_token: "sess-tok-123" } };
        } else {
          body = { session_token: "sess-tok-123" };
        }
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        );
      },
    },
  }),
);

// The session-token store is native-auth's own dependency now; mock it at
// its module seam and capture the interactions.
mock.module("./session-token-store", () => ({
  clearSessionToken: () => {
    store.clearCalls += 1;
  },
  getSessionToken: () => store.saved.at(-1) ?? null,
  saveSessionToken: (token: string) => {
    store.saved.push(token);
  },
  onSessionTokenChange: () => () => undefined,
  setSessionTokenLogger: () => undefined,
}));
mock.module("@mycadet/local-mode", () => ({
  resolveLocalConfigFromEnv: () => ({ cloudUrl: "https://platform.example" }),
}));

const {
  __resetForTesting,
  configureNativeAuth,
  generateState,
  installNativeAuth,
} = await import("./native-auth");
const {
  __resetNotificationIdentityMemoryForTesting,
  getPreparedNotificationIdentity,
  prepareNotificationIdentity,
} = await import("./notification-identity-memory");

configureNativeAuth({
  activateWindow: () => {
    refocus.appFocusSteal += 1;
    refocus.ensureVisible += 1;
  },
});

afterEach(() => {
  __resetForTesting();
  __resetNotificationIdentityMemoryForTesting();
  store.saved.length = 0;
  store.clearCalls = 0;
  lastOpenedUrl = "";
  cookieRemoveCalls.length = 0;
  refocus.appFocusSteal = 0;
  refocus.ensureVisible = 0;
  recordedIpcHandlers.clear();
  recordedIpcOnListeners.clear();
});

describe("generateState", () => {
  test("returns a base64url-encoded string of sufficient length", () => {
    const state = generateState();
    expect(state.length).toBeGreaterThanOrEqual(16);
    expect(/^[A-Za-z0-9_-]+$/.test(state)).toBe(true);
  });

  test("generates unique values", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});

describe("installNativeAuth session-token wiring", () => {
  test("persists the exchanged token on successful PKCE login", async () => {
    installNativeAuth();

    const startOAuth = recordedIpcHandlers.get("cadet:auth:startOAuth");
    expect(startOAuth).toBeDefined();

    const pending = startOAuth!(allowedEvent, {}) as Promise<{
      sessionToken: string;
    }>;

    // Wait for the async setup (config fetch + listener bind) to open the
    // browser at the WorkOS authorize URL.
    while (!lastOpenedUrl) await Bun.sleep(1);
    const opened = new URL(lastOpenedUrl);
    expect(opened.pathname).toBe("/user_management/authorize");
    expect(opened.searchParams.get("client_id")).toBe("client_um_test");
    expect(opened.searchParams.get("code_challenge_method")).toBe("S256");

    // Play the browser: hit the real loopback listener with the code.
    const redirectUri = opened.searchParams.get("redirect_uri")!;
    const state = opened.searchParams.get("state")!;
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    const res = await fetch(`${redirectUri}?code=auth-code-xyz&state=${state}`);
    expect(res.status).toBe(200);

    const result = await pending;
    expect(result.sessionToken).toBe("sess-tok-123");
    expect(store.saved).toContain("sess-tok-123");
    // Reopen the app: steal foreground from the browser and surface the window.
    expect(refocus.appFocusSteal).toBe(1);
    expect(refocus.ensureVisible).toBe(1);
  });

  test("evicts both legacy session cookies on install", () => {
    installNativeAuth();
    // Eviction fires synchronously (Promise.all over the cookie names).
    const names = cookieRemoveCalls.map((c) => c.name);
    expect(names).toContain("sessionid");
    expect(names).toContain("__Secure-sessionid");
    expect(
      cookieRemoveCalls.every((c) => c.url === "https://platform.example"),
    ).toBe(true);
  });

  test("signOut clears the persisted token", async () => {
    const identity = {
      scopeId: `scope:v1:${"a".repeat(64)}`,
      assistantId: "assistant-a",
      nativeSenderId: "native-a",
    };
    prepareNotificationIdentity({
      identity,
      scopeEpoch: 1,
      identityRevision: 1,
      name: "Alice",
      nameProvenance: "identity-store",
    });
    installNativeAuth();

    const signOut = recordedIpcHandlers.get("cadet:auth:signOut");
    expect(signOut).toBeDefined();

    await signOut!(allowedEvent);
    expect(store.clearCalls).toBe(1);
    expect(getPreparedNotificationIdentity(identity)).toBeNull();
    expect(
      prepareNotificationIdentity({
        identity,
        scopeEpoch: 1,
        identityRevision: 2,
        name: "Late name",
        nameProvenance: "identity-store",
      }),
    ).toBe(false);
  });

  test("cancelOAuth stops an active loopback flow", async () => {
    installNativeAuth();

    const pending = recordedIpcHandlers.get("cadet:auth:startOAuth")!(
      allowedEvent,
      {},
    ) as Promise<{
      sessionToken: string;
    }>;
    while (!lastOpenedUrl) {
      await Bun.sleep(1);
    }

    await recordedIpcHandlers.get("cadet:auth:cancelOAuth")!(allowedEvent);
    await expect(pending).rejects.toThrow("Auth flow cancelled");
  });

  test("exposes the cached token over sync IPC", () => {
    installNativeAuth();
    store.saved.push("cached-tok");

    const listener = recordedIpcOnListeners.get(
      "cadet:auth:getSessionToken",
    )?.[0];
    expect(listener).toBeDefined();
    const syncEvent: { returnValue?: string } = { ...allowedEvent };
    listener?.(syncEvent);
    expect(syncEvent.returnValue).toBe("cached-tok");
  });
});
