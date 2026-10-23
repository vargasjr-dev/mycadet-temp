import { ensureCsrfCookie, getCsrfToken } from "@app/lib/auth/csrf";
import {
  ATTRIBUTION_PARAMS,
  readAttributionParams,
} from "@app/domains/account/attribution";

export type ProviderIntent = "login" | "signup";
const PROVIDER_REDIRECT_PATH = "/_allauth/browser/v1/auth/provider/redirect";

export interface ProviderRedirectOptions {
  readonly intent?: ProviderIntent;
  /** Pre-fill the WorkOS AuthKit email field (and email-first flows). */
  readonly loginHint?: string;
  /** Campaign attribution to forward, from {@link readAttributionParams}. */
  readonly attribution?: Record<string, string>;
}

/**
 * Build the form fields posted to the backend provider-redirect view.
 *
 * Extracted as a pure helper so the intent-plumbing behavior can be unit
 * tested without a DOM environment.
 */
export function buildProviderRedirectFields(
  providerId: string,
  callbackUrl: string,
  origin: string,
  options: ProviderRedirectOptions = {},
): Record<string, string> {
  const fields: Record<string, string> = {
    provider: providerId,
    callback_url: new URL(callbackUrl, origin).href,
    process: "login",
  };

  if (options.intent) {
    fields["intent"] = options.intent;
  }
  if (options.loginHint) {
    fields["login_hint"] = options.loginHint;
  }
  // Assigned before the reserved fields above would be reachable, but written
  // after them so a crafted `?provider=` or `?callback_url=` on the landing
  // URL can never override the redirect target.
  for (const key of ATTRIBUTION_PARAMS) {
    const value = options.attribution?.[key];
    if (value) {
      fields[key] = value;
    }
  }

  return fields;
}

/**
 * Assert that a CSRF token is present before kicking off a provider redirect.
 *
 * Extracted as a tiny pure helper so the assertion behavior can be unit tested
 * without a DOM environment. `ensureCsrfCookie()` swallows bootstrap failures
 * (see `@app/lib/auth/csrf`), so without this guard we would silently POST to
 * `PROVIDER_REDIRECT_PATH` with no token and get a 403 back from the cloud — the
 * user would be stuck on the auth page with no feedback. Failing loudly here
 * surfaces the problem in the browser console instead.
 */
export function assertCsrfToken(
  token: string | null | undefined,
): asserts token is string {
  if (!token) {
    throw new Error(
      "Unable to start provider redirect: CSRF token is missing. The session may not be initialized. Please refresh the page and try again.",
    );
  }
}

/**
 * Kick off a provider redirect by submitting a hidden form.
 *
 * The endpoint at `PROVIDER_REDIRECT_PATH` expects an `application/x-www-form-urlencoded`
 * POST that results in a full-page redirect. It can't be done via XHR.
 */
export async function startProviderRedirect(
  providerId: string,
  callbackUrl: string,
  options: ProviderRedirectOptions = {},
): Promise<void> {
  await ensureCsrfCookie();

  // `ensureCsrfCookie()` swallows bootstrap failures, so we must verify a
  // token is actually available before building the form. Without this
  // guard, the POST to `PROVIDER_REDIRECT_PATH` would be rejected with 403
  // and the user would be stuck on the auth page.
  const csrfToken = getCsrfToken();
  assertCsrfToken(csrfToken);

  const origin = window.location.origin;
  const form = document.createElement("form");
  form.method = "POST";

  form.action = `${origin}${PROVIDER_REDIRECT_PATH}`;

  const fields = buildProviderRedirectFields(providerId, callbackUrl, origin, {
    ...options,
    // Read here rather than threaded from each screen so every entry point
    // forwards attribution: the landing page carries it in the URL precisely
    // because the cookie may not have survived the browser handoff.
    attribution:
      options.attribution ?? readAttributionParams(window.location.search),
  });
  fields["csrfmiddlewaretoken"] = csrfToken;

  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}
