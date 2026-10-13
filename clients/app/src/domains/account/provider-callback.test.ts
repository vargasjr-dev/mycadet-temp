import { expect, test } from "bun:test";
import {
  buildProviderCallbackUrl,
  readAuthCallbackIntent,
} from "@app/domains/account/provider-callback";
import {
  PROVIDER_CALLBACK_URL,
  PROVIDER_ID,
} from "@app/domains/account/provider";
import { classifyCallbackFlows } from "@app/domains/account/callback-flows";
import { requiresFullPageNavigation } from "@app/domains/account/full-page-navigation";

test("provider callback round trips return URL and signup intent", () => {
  expect(PROVIDER_ID).toBe("workos");
  expect(buildProviderCallbackUrl(null)).toBe(PROVIDER_CALLBACK_URL);
  const url = new URL(
    buildProviderCallbackUrl("/assistant?tab=home", { authIntent: "signup" }),
    "https://example.com",
  );
  expect(url.pathname).toBe("/account/provider/callback");
  expect(url.searchParams.get("returnTo")).toBe("/assistant?tab=home");
  expect(readAuthCallbackIntent(url.searchParams)).toBe("signup");
  expect(
    readAuthCallbackIntent(new URLSearchParams("authIntent=unknown")),
  ).toBe("login");
});

test("callback outcomes distinguish signed-in, pending signup, and failure", () => {
  expect(classifyCallbackFlows(true, [])).toEqual({ kind: "authenticated" });
  expect(
    classifyCallbackFlows(false, [{ id: "provider_signup", is_pending: true }]),
  ).toEqual({ kind: "provider_signup" });
  expect(
    classifyCallbackFlows(false, [{ id: "provider_signup", is_pending: false }])
      .kind,
  ).toBe("error");
});

test("account destinations choose page loads only for non-SPA surfaces", () => {
  for (const path of [
    "https://mycadet.ai/account",
    "/accounts/start",
    "/v1/user/me",
    "/_allauth/browser/v1",
    "/import",
  ])
    expect(requiresFullPageNavigation(path)).toBe(true);
  for (const path of ["/assistant", "/account/signup"])
    expect(requiresFullPageNavigation(path)).toBe(false);
});
