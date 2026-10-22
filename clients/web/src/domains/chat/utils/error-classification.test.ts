import { describe, expect, test } from "bun:test";

import {
  isCloudCredentialChatError,
  shouldShowGenericChatErrorNotice,
  shouldSuppressGenericChatErrorNotice,
} from "@/domains/chat/utils/error-classification";

describe("chat error classification", () => {
  test("routes managed key failures through the generic Doctor-capable notice", () => {
    const error = {
      code: "MANAGED_KEY_INVALID",
      errorCategory: "managed_key_invalid",
    };

    expect(isCloudCredentialChatError(error)).toBe(true);
    expect(shouldSuppressGenericChatErrorNotice(error)).toBe(false);
    expect(shouldShowGenericChatErrorNotice(error)).toBe(true);
  });

  test("suppresses inline notice when displayAs is modal", () => {
    // secret_blocked from a fresh new-conversation POST is surfaced as a
    // dialog, not an inline banner. The inline Notice must stay hidden so
    // the dialog is the only visible error surface.
    const error = {
      code: "secret_blocked",
      displayAs: "modal" as const,
    };

    expect(shouldSuppressGenericChatErrorNotice(error)).toBe(true);
    expect(shouldShowGenericChatErrorNotice(error)).toBe(false);
  });

  test("does not suppress inline notice when displayAs is inline or absent", () => {
    expect(shouldSuppressGenericChatErrorNotice({ displayAs: "inline" })).toBe(
      false,
    );
    expect(shouldSuppressGenericChatErrorNotice({})).toBe(false);
    expect(
      shouldShowGenericChatErrorNotice({ code: "X", displayAs: "inline" }),
    ).toBe(true);
  });
});

