import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { routes } from "@/utils/routes";

export function nativeAuthReturningUser(): boolean {
  return buildNavigationState().userHasOnboardedAssistant;
}

export const PROVIDER_ID = "workos";
export const PROVIDER_CALLBACK_URL = routes.account.providerCallback;
export type AuthCallbackIntent = "login" | "signup";

const AUTH_INTENT_QUERY_PARAM = "authIntent";

export function buildProviderCallbackUrl(
  returnTo: string | null,
  options: { authIntent?: AuthCallbackIntent } = {},
): string {
  const params = new URLSearchParams();
  if (returnTo) {
    params.set("returnTo", returnTo);
  }
  if (options.authIntent) {
    params.set(AUTH_INTENT_QUERY_PARAM, options.authIntent);
  }
  const qs = params.toString();
  if (!qs) {
    return PROVIDER_CALLBACK_URL;
  }
  return `${PROVIDER_CALLBACK_URL}?${qs}`;
}

export function readAuthCallbackIntent(
  searchParams: URLSearchParams,
): AuthCallbackIntent {
  return searchParams.get(AUTH_INTENT_QUERY_PARAM) === "signup"
    ? "signup"
    : "login";
}

export function requiresFullPageNavigation(destination: string): boolean {
  return (
    destination.startsWith("http") ||
    destination.startsWith("/accounts/") ||
    destination.startsWith("/v1/") ||
    destination.startsWith("/_allauth/") ||
    // The bring-your-agent import funnel is a marketing page served by the
    // platform Next.js app, not this SPA — client-side navigation would miss.
    destination.startsWith("/import")
  );
}

/**
 * In-SPA surfaces that only do their job against a live cloud account.
 * Reached on a gateway-only identity, `/account` reports a signed-in state for
 * an account that is not there. Matched by prefix, so sub-paths count.
 */
const CLOUD_ONLY_PATHS: readonly string[] = [routes.account.root];

/**
 * Does landing on `destination` need a live cloud session, or is a local
 * gateway identity enough?
 *
 * Two families need one. Anything the cloud serves rather than this SPA:
 * the Django account routes, the API, the marketing import funnel and any
 * mycadet.ai URL. And the cloud-only in-app surfaces above.
 *
 * Everything else is daemon-served and works on a local session, including
 * `/assistant/settings/usage`: the Usage tab reads from the local daemon.
 */
export function requiresCloudSession(destination: string): boolean {
  if (requiresFullPageNavigation(destination)) {
    return true;
  }
  const path = destination.split(/[?#]/)[0] ?? destination;
  return CLOUD_ONLY_PATHS.some(
    (candidate) => path === candidate || path.startsWith(`${candidate}/`),
  );
}

export function resolvePostLoginDestination(
  returnTo: string | null,
  fallback: string,
): {
  destination: string;
  requiresFullPageNavigation: boolean;
} {
  return resolvePostAuthDestination({
    returnTo,
    fallback,
    authIntent: "login",
  });
}

export function resolvePostAuthDestination({
  returnTo,
  fallback,
  authIntent,
}: {
  returnTo: string | null;
  fallback: string;
  authIntent: AuthCallbackIntent;
}): {
  destination: string;
  requiresFullPageNavigation: boolean;
} {
  const decision = resolveNavigation(buildNavigationState(), {
    kind: "post-auth",
    authIntent,
    returnTo,
    fallback,
  });
  const destination = decision.action === "redirect" ? decision.to : fallback;
  return {
    destination,
    requiresFullPageNavigation: requiresFullPageNavigation(destination),
  };
}
