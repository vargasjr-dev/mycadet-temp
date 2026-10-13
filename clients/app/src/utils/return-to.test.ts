import { expect, test } from "bun:test";
import { sanitizeReturnTo } from "@app/utils/return-to";

test("account return URLs preserve local paths and HTTPS Cadet destinations", () => {
  for (const path of [
    "/assistant?tab=home",
    "/accounts/start?redirect_uri=https://example.com",
    "https://mycadet.ai/account",
    "https://dev.mycadet.ai/assistant",
  ]) {
    expect(sanitizeReturnTo(path, "/account")).toBe(path);
  }
});

test("account return URLs reject foreign origins and browser redirect tricks", () => {
  for (const path of [
    null,
    "",
    "https://evil.com",
    "https://mycadet.ai.evil.com",
    "https://evilmycadet.ai",
    "http://mycadet.ai",
    "//evil.com",
    "/\\evil.com",
    "javascript:alert(1)",
    "https://[",
  ]) {
    expect(sanitizeReturnTo(path, "/account")).toBe("/account");
  }
});
