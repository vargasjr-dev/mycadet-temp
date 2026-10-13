import { expect, test } from "bun:test";
import {
  getOAuthCompleteMessagePayload,
  getOAuthCompleteStoragePayload,
  oauthCompletionStorageKey,
  parseOAuthCompletePayload,
} from "@app/lib/auth/oauth-popup";

const payload = {
  type: "cadet:oauth-complete",
  requestId: "request-1",
  oauthStatus: "success",
};

test("popup completion matches the opener's origin and request", () => {
  const event = new MessageEvent("message", {
    origin: "https://mycadet.ai",
    data: payload,
  });
  expect(
    getOAuthCompleteMessagePayload(event, "https://mycadet.ai", "request-1"),
  ).toEqual(payload);
  expect(
    getOAuthCompleteMessagePayload(event, "https://evil.com", "request-1"),
  ).toBeNull();
  expect(
    getOAuthCompleteMessagePayload(event, "https://mycadet.ai", "request-2"),
  ).toBeNull();
});

test("storage completion preserves the cross-client key and request filter", () => {
  expect(oauthCompletionStorageKey("request-1")).toBe(
    "cadet:oauth-complete:request-1",
  );
  const event = new StorageEvent("storage", {
    key: oauthCompletionStorageKey("request-1"),
    newValue: JSON.stringify(payload),
  });
  expect(getOAuthCompleteStoragePayload(event, "request-1")).toEqual(payload);
  expect(getOAuthCompleteStoragePayload(event, "request-2")).toBeNull();
  expect(parseOAuthCompletePayload("broken json")).toBeNull();
  expect(
    parseOAuthCompletePayload('{"type":"cadet:oauth-complete","requestId":7}'),
  ).toBeNull();
});
