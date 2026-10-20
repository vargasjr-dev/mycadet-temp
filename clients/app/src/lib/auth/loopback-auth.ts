import { cloudWebUrl } from "@mycadet/environments/seeds";

/**
 * Loopback authentication for local-mode web UI.
 *
 * Mirrors the CLI's `cadet login` browser flow: navigates to the
 * cloud's login page, which authenticates via WorkOS and redirects
 * back to `http://localhost:{port}/callback?state=...&session_token=...`.
 * The local web server forwards `/callback` to the SPA's `CloudLoopbackPage`,
 * which validates the state and registers the token with the local server so
 * its cloud proxy can authenticate — no browser session cookie is used.
 */

const LOOPBACK_STATE_KEY = "cadet:loopback:state";
const LOOPBACK_RETURN_TO_KEY = "cadet:loopback:returnTo";

/** The cloud login base comes from the build's environment seed, not the
 * injected config — the config carries only the origins a served bundle
 * can't infer, and the loopback handoff only runs in standalone local mode
 * where the build's seed owns the routing. */
function cloudLoginUrl(page: string, callbackReturnTo: string): string {
  return `${cloudWebUrl()}/account/${page}?returnTo=${encodeURIComponent(callbackReturnTo)}`;
}

function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function startLoopbackAuth(
  returnTo?: string,
  options?: { intent?: string },
): Promise<void> {
  const state = generateState();
  const port = window.location.port || "3000";

  sessionStorage.setItem(LOOPBACK_STATE_KEY, state);
  if (returnTo) {
    sessionStorage.setItem(LOOPBACK_RETURN_TO_KEY, returnTo);
  }

  const callbackReturnTo = `/accounts/cli/callback?port=${port}&state=${state}`;
  const page = options?.intent === "signup" ? "signup" : "login";

  window.location.href = cloudLoginUrl(page, callbackReturnTo);
}
