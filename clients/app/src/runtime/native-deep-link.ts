export interface OAuthCompleteDeepLinkPayload {
  requestId: string;
  oauthStatus: string | null;
  oauthProvider: string | null;
  oauthCode: string | null;
}

const NATIVE_URL_SCHEME_BY_HOST: Record<string, string> = {
  "www.mycadet.ai": "cadet",
  "mycadet.ai": "cadet",
  "staging.mycadet.ai": "cadet-staging",
  "dev.mycadet.ai": "cadet-dev",
};

export function getNativeUrlSchemeForHost(host: string): string | null {
  return NATIVE_URL_SCHEME_BY_HOST[host] ?? null;
}

const OAUTH_COMPLETE_DEEP_LINK_HOST = "oauth-complete";

export function buildOAuthCompleteDeepLink(
  scheme: string,
  payload: OAuthCompleteDeepLinkPayload,
): string {
  const params = new URLSearchParams();
  params.set("requestId", payload.requestId);
  if (payload.oauthStatus !== null) {
    params.set("oauth_status", payload.oauthStatus);
  }
  if (payload.oauthProvider !== null) {
    params.set("oauth_provider", payload.oauthProvider);
  }
  if (payload.oauthCode !== null) {
    params.set("oauth_code", payload.oauthCode);
  }
  return `${scheme}://${OAUTH_COMPLETE_DEEP_LINK_HOST}?${params.toString()}`;
}
