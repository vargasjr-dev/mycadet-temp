import { PROVIDER_CALLBACK_URL } from "@app/domains/account/provider";

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
