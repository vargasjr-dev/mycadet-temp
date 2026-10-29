import { Capacitor, registerPlugin } from "@capacitor/core";
import { useSyncExternalStore } from "react";

import { sanitizeReturnTo } from "@/utils/return-to";
import { getSession } from "@/lib/auth/allauth-client";
import {
  isBiometricEnabled,
  setBiometricEnabled,
  storeBiometricToken,
} from "@/runtime/native-biometric";
import { routes } from "@/utils/routes";

/**
 * JS ↔ native bridge for the `NativeAuth` Capacitor plugin registered by the
 * iOS and Android native shells.
 *
 * The plugins open the cloud browser auth surface against WorkOS AuthKit
 * with PKCE. After authentication, WorkOS delivers a short-lived,
 * single-use authorization code via the custom URL scheme. The native plugin
 * exchanges that code for a WorkOS access token, then swaps it for a cloud
 * session token. The raw session key never transits the custom scheme.
 *
 * This bundle never starts a login — the app bundle owns the auth flows and
 * hands the resulting session over. What lives here is the receive side:
 * restoring a login whose WebView process was recreated mid-flow, plus the
 * cookie installation and session probe that handshake relies on.
 */

interface NativeAuthPlugin {
  startAuth(options: {
    baseURL: string;
    loginHint?: string;
    intent?: string;
    /**
     * Allowlisted campaign params. The shell appends them as query params on
     * its token POST: allauth headless posts JSON, so the cloud reads
     * attribution off `request.GET`. Omitted when empty, so a shell that
     * predates this field sees an unchanged call.
     */
    attribution?: Record<string, string>;
    postAuthDestination: string;
  }): Promise<{ sessionToken: string }>;
  consumeRestoredAuth(): Promise<{
    sessionToken?: string;
    postAuthDestination?: string;
    error?: string;
    errorCode?: string;
  }>;
}

const NativeAuth = registerPlugin<NativeAuthPlugin>("NativeAuth");

/** Fallback destination after a successful native login. */
const DEFAULT_POST_AUTH_DESTINATION = routes.assistant;

/**
 * True when we're running inside a Capacitor native shell. Safe to call
 * server-side, so it falls through to `false` before hydration.
 */
export function isNativePlatform(): boolean {
  return typeof window !== "undefined" && Capacitor.isNativePlatform();
}

/**
 * Hook form of `isNativePlatform()`, safe to call from a render body.
 *
 * The value is correct on the very first render and constant thereafter:
 * Capacitor injects `native-bridge.js` as a `WKUserScript` at
 * `.atDocumentStart`, so `window.Capacitor` exists before this bundle
 * executes. `subscribe` is a noop because nothing can change the value, and
 * the `getServerSnapshot` argument is unreachable because `clients/web`
 * renders client-only through `createRoot` (no SSR, no hydration).
 *
 * Prefer it over the bare function in JSX (docs/CAPACITOR.md): it keeps the
 * shape consistent with the cloud hooks in `runtime/platform-detection.ts`
 * and stays correct if a prerender step is ever added. There is no first-paint
 * flicker to avoid.
 */
const noop = () => () => {};
export function useIsNativePlatform(): boolean {
  return useSyncExternalStore(noop, isNativePlatform, () => false);
}

/** Resume an Android browser login whose WebView process was recreated. */
export async function restorePendingNativeLogin(): Promise<void> {
  if (!isNativePlatform() || Capacitor.getPlatform() !== "android") {
    return;
  }
  const result = await NativeAuth.consumeRestoredAuth();
  if (result.error) {
    const error = new Error(result.error) as Error & { code?: string };
    error.code = result.errorCode;
    throw error;
  }
  if (!result.sessionToken) {
    return;
  }
  const destination = sanitizeReturnTo(
    result.postAuthDestination ?? null,
    DEFAULT_POST_AUTH_DESTINATION,
  );
  await completeNativeLogin(result.sessionToken, destination);
}

async function completeNativeLogin(
  sessionToken: string,
  destination: string,
): Promise<void> {
  // `document.cookie` can't set HttpOnly, but the cloud validates the
  // session by DB lookup; the HttpOnly flag is client-side only.
  //
  // We set BOTH `sessionid` (dev) and `__Secure-sessionid` (prod) so
  // the same code works across environments without runtime host
  // sniffing. Whichever name the server is configured to read, it
  // finds. The `__Secure-` prefix has browser-enforced rules: HTTPS
  // origin + `Secure` attribute, both of which apply here.
  //
  // The JS-side cookie is the source of truth for the native WebView session.
  installSessionCookies(sessionToken);

  // Native WebViews can flush `document.cookie` writes asynchronously.
  // Without a synchronization step, the subsequent
  // hard navigation can race the flush and the request to `/assistant`
  // goes out without the session cookie — the cloud sees an anonymous user,
  // `AuthProvider` redirects back to `/account/login`, and the user is
  // dumped at the login screen even though auth itself succeeded.
  //
  // Probe `/_allauth/browser/v1/auth/session` until the server agrees
  // we're authenticated. This both (a) forces the WebView to flush the
  // cookie store so subsequent requests carry the cookie and (b) confirms
  // The cloud actually recognized it before we navigate.
  //
  // The biometric branch below incidentally awaited enough async work
  // to mask the race for biometrics-enabled users, which is why this
  // bug only reproduces consistently when biometrics is off.
  if (isNativePlatform()) {
    await waitForNativeSessionCookie();
  }

  // Persist the token in native secure storage for biometric session recovery.
  // Respects the user's opt-out preference; storeBiometricToken is also
  // a no-op if biometrics are unavailable on the device.
  if (isBiometricEnabled()) {
    const stored = await storeBiometricToken(sessionToken);
    if (!stored && Capacitor.getPlatform() === "android") {
      setBiometricEnabled(false);
    }
  }

  window.location.href = destination;
}

/**
 * Block until the just-written session cookie is reachable to the cloud.
 *
 * Polls `getSession()` with backoff. Each call is a real same-origin
 * fetch with `credentials: "include"`, so the native WebView has to send the
 * cookie from its store — if `document.cookie` hasn't flushed yet, the
 * server returns anonymous and we retry until it does.
 *
 * If every attempt fails we still fall through and let the navigation
 * proceed; the post-nav `AuthProvider` may succeed once the store
 * finally settles, and a stuck loop here would block the user worse
 * than a possible re-login.
 */
export async function waitForNativeSessionCookie(): Promise<void> {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await getSession();
      if (result.ok && result.data.user) {
        return;
      }
    } catch {
      // Transient network errors fall through to the backoff.
    }
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
}

/**
 * Install cloud session cookies for both dev and prod environments. Sets both
 * `sessionid` (dev) and `__Secure-sessionid` (prod) so the same code works
 * across environments without runtime host sniffing.
 */
export function installSessionCookies(sessionToken: string): void {
  // `max-age` makes the cookie persistent. If unspecified, the cookie
  // expires at the end of the session, and users will be required to
  // login again.
  const cookieAttrs =
    "path=/; domain=.mycadet.ai; secure; samesite=lax; max-age=1209600";
  document.cookie = `sessionid=${sessionToken}; ${cookieAttrs}`;
  document.cookie = `__Secure-sessionid=${sessionToken}; ${cookieAttrs}`;
}

/**
 * Read the current cloud session token from cookies.
 * Checks `__Secure-sessionid` (prod) then `sessionid` (dev).
 */
export function getSessionTokenFromCookies(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const cookies = document.cookie.split("; ");
  for (const name of ["__Secure-sessionid", "sessionid"]) {
    const entry = cookies.find((c) => c.startsWith(`${name}=`));
    if (entry) {
      const value = entry.slice(name.length + 1);
      if (value) {
        return value;
      }
    }
  }
  return null;
}
