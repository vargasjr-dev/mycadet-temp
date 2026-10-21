import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  ANDROID_PLAY_STORE_URL,
  incrementNativeAppAssistantTurnsSeen,
  openNativeAppStore,
  readNativeAppAssistantTurnsSeen,
  readNativeAppDownloaded,
  resolveMobilePromotion,
  useNativeAppNudgeState,
  writeNativeAppDownloaded,
} from "@/hooks/use-native-app-nudge";

const IOS_STORE_URL = "https://apps.apple.com/us/app/mycadet/id6759934423";
const DOWNLOADS_URL = "https://www.mycadet.ai/downloads";

const originalWindowOpen = window.open;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.open = originalWindowOpen;
});

describe("Android promotion readiness", () => {
  test("tags the listing with an install referrer", () => {
    const url = new URL(ANDROID_PLAY_STORE_URL);

    expect([...url.searchParams.keys()]).toEqual(["id", "referrer"]);
    expect(url.searchParams.get("id")).toBe("ai.mycadet.android");
    expect(url.searchParams.get("referrer")).toBe(
      "utm_source=cadet-app&utm_medium=in-app-nudge",
    );
  });

  test("sends Android to the Play listing", () => {
    const open = mock(() => null);
    window.open = open as typeof window.open;

    openNativeAppStore("android");
    expect(open).toHaveBeenCalledWith(
      ANDROID_PLAY_STORE_URL,
      "_blank",
      "noopener,noreferrer",
    );
  });
});

describe("resolveMobilePromotion", () => {
  test("promotes the App Store listing on iOS", () => {
    expect(resolveMobilePromotion("ios")).toEqual({
      target: "ios",
      appName: "iOS",
      storeUrl: IOS_STORE_URL,
    });
  });

  test("promotes the Play listing on Android", () => {
    expect(resolveMobilePromotion("android")).toEqual({
      target: "android",
      appName: "Android",
      storeUrl: ANDROID_PLAY_STORE_URL,
    });
  });

  test("falls back to generic when the cloud is unknown", () => {
    expect(resolveMobilePromotion(null)).toEqual({
      target: "generic",
      appName: null,
      storeUrl: DOWNLOADS_URL,
    });
  });
});

describe("native app nudge state", () => {
  test("reads the existing iOS dismissal key", () => {
    localStorage.setItem("app.iosNudge.bannerDismissed", "true");

    const { result } = renderHook(() => useNativeAppNudgeState("ios"));

    expect(result.current.bannerShouldShow).toBe(false);
  });

  test("keeps iOS download state on the existing key", () => {
    const open = mock(() => null);
    window.open = open as typeof window.open;
    const { result } = renderHook(() => useNativeAppNudgeState("ios"));

    act(() => result.current.handleDownload());

    expect(open).toHaveBeenCalledWith(
      IOS_STORE_URL,
      "_blank",
      "noopener,noreferrer",
    );
    expect(localStorage.getItem("app.iosNudge.downloaded")).toBe("true");
    expect(result.current.bannerShouldShow).toBe(false);
  });

  test("keeps Android state separate from iOS", () => {
    const { result } = renderHook(() => useNativeAppNudgeState("android"));

    act(() => result.current.handleBannerDismiss());
    incrementNativeAppAssistantTurnsSeen("android", 3);

    expect(localStorage.getItem("app.androidNudge.bannerDismissed")).toBe(
      "true",
    );
    expect(localStorage.getItem("app.iosNudge.bannerDismissed")).toBeNull();
    expect(readNativeAppAssistantTurnsSeen("android")).toBe(3);
    expect(localStorage.getItem("app.iosNudge.assistantTurnsSeen")).toBeNull();
  });

  test("stores generic nudge state under the mobile keys", () => {
    const open = mock(() => null);
    window.open = open as typeof window.open;
    const { result } = renderHook(() => useNativeAppNudgeState("generic"));

    act(() => result.current.handleDownload());
    incrementNativeAppAssistantTurnsSeen("generic", 2);

    expect(open).toHaveBeenCalledWith(
      DOWNLOADS_URL,
      "_blank",
      "noopener,noreferrer",
    );
    expect(localStorage.getItem("app.mobileNudge.downloaded")).toBe("true");
    expect(localStorage.getItem("app.mobileNudge.assistantTurnsSeen")).toBe(
      "2",
    );
    expect(result.current.bannerShouldShow).toBe(false);
  });

  test("writes a dismissal only to the target's own key", () => {
    const { result } = renderHook(() => useNativeAppNudgeState("generic"));

    act(() => result.current.handleBannerDismiss());

    expect(localStorage.getItem("app.mobileNudge.bannerDismissed")).toBe(
      "true",
    );
    expect(localStorage.getItem("app.iosNudge.bannerDismissed")).toBeNull();
    expect(localStorage.getItem("app.androidNudge.bannerDismissed")).toBeNull();
  });
});

describe("cross-target nudge reads", () => {
  test("carries an Android dismissal over to the generic banner", () => {
    localStorage.setItem("app.androidNudge.bannerDismissed", "true");

    const { result } = renderHook(() => useNativeAppNudgeState("generic"));

    expect(result.current.bannerShouldShow).toBe(false);
  });

  test("carries a generic dismissal back to the Android banner", () => {
    localStorage.setItem("app.mobileNudge.bannerDismissed", "true");

    const { result } = renderHook(() => useNativeAppNudgeState("android"));

    expect(result.current.bannerShouldShow).toBe(false);
  });

  test("treats a download recorded on any target as downloaded", () => {
    writeNativeAppDownloaded("ios");

    expect(readNativeAppDownloaded("generic")).toBe(true);
    expect(readNativeAppDownloaded("android")).toBe(true);
  });

  test("takes the highest turn count so a target flip keeps progress", () => {
    incrementNativeAppAssistantTurnsSeen("android", 4);

    expect(readNativeAppAssistantTurnsSeen("generic")).toBe(4);

    incrementNativeAppAssistantTurnsSeen("generic");

    expect(localStorage.getItem("app.mobileNudge.assistantTurnsSeen")).toBe(
      "5",
    );
    expect(readNativeAppAssistantTurnsSeen("android")).toBe(5);
  });
});
