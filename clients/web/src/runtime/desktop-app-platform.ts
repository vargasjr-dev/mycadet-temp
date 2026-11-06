import { useSyncExternalStore } from "react";

import { isElectron } from "@/runtime/is-electron";

export type DesktopAppPlatform = "macos" | "windows";

export function getBrowserPlatform(): string {
  const uaData = (
    navigator as Navigator & {
      userAgentData?: { platform?: string };
    }
  ).userAgentData;
  return uaData?.platform || navigator.platform;
}

/** Windows is the only positive match; every other signal defaults to macOS. */
export function detectDesktopAppPlatform(): DesktopAppPlatform {
  if (isElectron() && window.cadet?.hostOS) {
    return window.cadet.hostOS === "windows" ? "windows" : "macos";
  }

  return isWindowsBrowser() ? "windows" : "macos";
}

/** True when browser platform signals identify Windows. */
export function isWindowsBrowser(): boolean {
  return (
    /win/i.test(getBrowserPlatform()) || /Windows/i.test(navigator.userAgent)
  );
}

/** Excludes identified desktop systems outside the macOS/Windows promotion. */
export function isKnownUnsupportedDesktopBrowser(): boolean {
  const platformSignals = `${getBrowserPlatform()} ${navigator.userAgent}`;
  return /\b(?:CrOS|Linux|X11|FreeBSD|OpenBSD|NetBSD)\b/i.test(platformSignals);
}

const noop = () => () => {};

/** Hook form of `detectDesktopAppPlatform()`, safe in render bodies. */
export function useDesktopAppPlatform(): DesktopAppPlatform {
  return useSyncExternalStore(noop, detectDesktopAppPlatform, () => "macos");
}
