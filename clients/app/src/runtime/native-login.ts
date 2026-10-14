import { Capacitor, registerPlugin } from "@capacitor/core";
import { getSession } from "@app/lib/auth/session-client";
import { sanitizeReturnTo } from "@app/utils/return-to";
import { routes } from "@app/utils/routes";
import { isNativePlatform } from "@app/runtime/native-platform";
import { resolveNativeAttribution } from "@app/runtime/native-attribution";
import { markInstallReferrerSpent } from "@app/runtime/install-referrer";
import {
  isBiometricEnabled,
  setBiometricEnabled,
  storeBiometricToken,
} from "@app/runtime/native-biometric";
import { nativeCheckoutHandoff } from "@web/runtime/native-auth";
import { clearStaleNativeCheckoutStash } from "@app/runtime/native-post-auth-destination";
const DEFAULT_POST_AUTH_DESTINATION = routes.assistant;

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
}

const NativeAuth = registerPlugin<NativeAuthPlugin>("NativeAuth");

export function deriveAuthBaseURL(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

export async function startNativeLogin(options?: {
  baseURL?: string;
  returnTo?: string | null;
  loginHint?: string;
  intent?: string;
  attribution?: Record<string, string>;
}): Promise<void> {
  // Every native auth entry routes through the shared stale-stash cleanup. The
  // direct login form (`login-page.tsx`) calls this without going through
  // `resolveNativePostAuthDestination`, so without this a stash abandoned by a
  // prior native checkout-signup could leak into a later login and wrongly
  // resume checkout from privacy.
  clearStaleNativeCheckoutStash(
    options?.intent,
    options?.returnTo,
    nativeCheckoutHandoff,
  );

  // Attribution resolves here for the same reason: the direct login form is
  // the auth entry a fresh Play install reaches, and the install referrer is
  // the only attribution such an install carries.
  const attribution = await resolveNativeAttribution(options?.attribution);

  const baseURL = options?.baseURL ?? deriveAuthBaseURL();
  const destination = sanitizeReturnTo(
    options?.returnTo ?? null,
    DEFAULT_POST_AUTH_DESTINATION,
  );
  const { sessionToken } = await NativeAuth.startAuth({
    baseURL,
    ...(options?.loginHint ? { loginHint: options.loginHint } : {}),
    ...(options?.intent ? { intent: options.intent } : {}),
    ...(attribution ? { attribution } : {}),
    postAuthDestination: destination,
  });

  await completeNativeLogin(sessionToken, destination);
}

async function completeNativeLogin(
  sessionToken: string,
  destination: string,
): Promise<void> {
  // `document.cookie` can't set HttpOnly, but Django validates the
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
  // goes out without the session cookie — Django sees an anonymous user,
  // `AuthProvider` redirects back to `/account/login`, and the user is
  // dumped at the login screen even though auth itself succeeded.
  //
  // Probe `/_allauth/browser/v1/auth/session` until the server agrees
  // we're authenticated. This both (a) forces the WebView to flush the
  // cookie store so subsequent requests carry the cookie and (b) confirms
  // Django actually recognized it before we navigate.
  //
  // The biometric branch below incidentally awaited enough async work
  // to mask the race for biometrics-enabled users, which is why this
  // bug only reproduces consistently when biometrics is off.
  if (isNativePlatform()) {
    await waitForNativeSessionCookie();
  }

  markInstallReferrerSpent();

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
 * Block until the just-written session cookie is reachable to Django.
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
 * Install Django session cookies for both dev and prod environments. Sets both
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
