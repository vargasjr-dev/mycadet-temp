import { expect, test } from "bun:test";
import {
  buildOAuthCompleteDeepLink,
  getNativeUrlSchemeForHost,
} from "@app/runtime/native-deep-link";

test("OAuth completion uses the native scheme for the current deployment", () => {
  expect(getNativeUrlSchemeForHost("www.mycadet.ai")).toBe("cadet");
  expect(getNativeUrlSchemeForHost("mycadet.ai")).toBe("cadet");
  expect(getNativeUrlSchemeForHost("staging.mycadet.ai")).toBe("cadet-staging");
  expect(getNativeUrlSchemeForHost("dev.mycadet.ai")).toBe("cadet-dev");
  expect(getNativeUrlSchemeForHost("evil.com")).toBeNull();
});

test("OAuth return links encode payload fields and omit absent ones", () => {
  const payload = {
    requestId: "request & ?",
    oauthStatus: "success",
    oauthProvider: "provider+name",
    oauthCode: "a&b=?",
  };
  const url = new URL(buildOAuthCompleteDeepLink("cadet-dev", payload));
  expect(url.protocol).toBe("cadet-dev:");
  expect(url.hostname).toBe("oauth-complete");
  expect(url.searchParams.get("requestId")).toBe(payload.requestId);
  expect(url.searchParams.get("oauth_code")).toBe(payload.oauthCode);
  expect(url.searchParams.get("oauth_provider")).toBe(payload.oauthProvider);
  const minimal = new URL(
    buildOAuthCompleteDeepLink("cadet", {
      requestId: "request",
      oauthStatus: null,
      oauthProvider: null,
      oauthCode: null,
    }),
  );
  expect([...minimal.searchParams.keys()]).toEqual(["requestId"]);
});
