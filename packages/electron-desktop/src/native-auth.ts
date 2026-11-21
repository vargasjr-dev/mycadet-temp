import crypto from "node:crypto";
import { z } from "zod";

import { session, shell } from "electron";

import { resolveLocalConfigFromEnv } from "@mycadet/local-mode";

import { handle, handleSync } from "./ipc";
import { clearNotificationIdentityMemory } from "./notification-identity-memory";
import {
  clearSessionToken,
  getSessionToken,
  saveSessionToken,
} from "./session-token-store";
import {
  buildAuthorizeUrl,
  exchangeAccessTokenForSession,
  exchangeCodeWithWorkos,
  fetchWorkosClientId,
  generatePkcePair,
  startLoopbackListener,
} from "./workos-pkce";

const AUTH_FLOW_TIMEOUT_MS = 5 * 60_000;

export function generateState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export interface NativeAuthCallback {
  redirectUri: string;
  waitForCode: Promise<string>;
  close: (reason?: string) => void;
}

export interface NativeAuthOptions {
  activateWindow: () => void | Promise<void>;
  startCallback?: (expectedState: string) => Promise<NativeAuthCallback>;
}

interface NativeAuthRuntime {
  activateWindow: () => void | Promise<void>;
  startCallback?: (expectedState: string) => Promise<NativeAuthCallback>;
  getCloudUrl: () => string;
  openExternal: (url: string) => void | Promise<void>;
  removeCookie: (url: string, name: string) => Promise<void>;
  sessionStore: {
    clear: typeof clearSessionToken;
    get: typeof getSessionToken;
    save: typeof saveSessionToken;
  };
}

// The pieces every consumer shipped identically — the cloud URL from the
// local config, the OS browser hand-off, the legacy-cookie eviction, and the
// session-token store — are the package's own dependencies now; callers
// bring only the window they want focused and, on the shells whose auth
// callback rides the deep-link scheme, the callback starter.
const runtimeFor = (options: NativeAuthOptions): NativeAuthRuntime => ({
  ...options,
  getCloudUrl: () => resolveLocalConfigFromEnv().cloudUrl,
  openExternal: (url) => shell.openExternal(url),
  removeCookie: (url, name) => session.defaultSession.cookies.remove(url, name),
  sessionStore: {
    clear: clearSessionToken,
    get: getSessionToken,
    save: saveSessionToken,
  },
});

let runtime: NativeAuthRuntime | null = null;

export const configureNativeAuth = (options: NativeAuthOptions): void => {
  runtime = runtimeFor(options);
};

const getRuntime = (): NativeAuthRuntime => {
  if (!runtime) {
    throw new Error("Native auth is not configured");
  }
  return runtime;
};

// Evict the session cookies installed by prior builds, so that
// header auth takes precedence.
async function clearLegacySessionCookies(): Promise<void> {
  const options = getRuntime();
  const url = options.getCloudUrl();
  await Promise.all(
    ["sessionid", "__Secure-sessionid"].map((name) =>
      options.removeCookie(url, name).catch(() => undefined),
    ),
  );
}

let activePkceCancel: ((reason?: string) => void) | null = null;

/**
 * App-held PKCE login (workos-pkce.ts). Drives the WorkOS OAuth flow in
 * the main process; the renderer is uninvolved beyond the IPC result.
 */
async function startOAuth(options: {
  loginHint?: string;
  intent?: string;
}): Promise<{ sessionToken: string }> {
  activePkceCancel?.();

  const runtimeOptions = getRuntime();
  const cloudUrl = runtimeOptions.getCloudUrl();
  const clientId = await fetchWorkosClientId(cloudUrl);
  const state = generateState();
  const { verifier, challenge } = generatePkcePair();
  const listener = await (
    runtimeOptions.startCallback ?? startLoopbackListener
  )(state);

  const timer = setTimeout(
    () => listener.close("Sign-in timed out. Please try again."),
    AUTH_FLOW_TIMEOUT_MS,
  );
  const cancelListener = listener.close;
  activePkceCancel = cancelListener;

  try {
    const authorizeUrl = buildAuthorizeUrl({
      clientId,
      redirectUri: listener.redirectUri,
      challenge,
      state,
      loginHint: options.loginHint,
      intent: options.intent,
    });
    void runtimeOptions.openExternal(authorizeUrl);

    const code = await listener.waitForCode;
    const accessToken = await exchangeCodeWithWorkos({
      clientId,
      code,
      verifier,
    });
    const sessionToken = await exchangeAccessTokenForSession(
      cloudUrl,
      clientId,
      accessToken,
    );

    runtimeOptions.sessionStore.save(sessionToken);
    void runtimeOptions.activateWindow();
    return { sessionToken };
  } finally {
    clearTimeout(timer);
    cancelListener();
    if (activePkceCancel === cancelListener) {
      activePkceCancel = null;
    }
  }
}

const startOAuthSchema = z.tuple([
  z.object({
    loginHint: z.string().optional(),
    intent: z.string().optional(),
  }),
]);

let installed = false;

export const installNativeAuth = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  const options = getRuntime();
  void clearLegacySessionCookies();

  handle(
    "cadet:auth:startOAuth",
    startOAuthSchema,
    async ([authOptions]): Promise<{ sessionToken: string }> =>
      startOAuth(authOptions),
  );

  handle("cadet:auth:cancelOAuth", z.tuple([]), () => {
    activePkceCancel?.();
  });

  handle("cadet:auth:signOut", z.tuple([]), () => {
    clearNotificationIdentityMemory();
    options.sessionStore.clear();
  });

  handleSync("cadet:auth:getSessionToken", () => options.sessionStore.get());
};

export const __resetForTesting = (): void => {
  installed = false;
  activePkceCancel?.();
};
