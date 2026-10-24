/**
 * Detect the client's OS surface at runtime — the app twin of web's
 * `runtime/platform-detection#detectClientOs`.
 *
 * This feeds the message body's `clientOs` field only (the side-conversation
 * machine prompts), which the assistant renders as the per-turn `client_os`
 * context line. It must NOT drive the message body's `interface` field or the
 * `X-Cadet-Interface-Id` registration header — those are the *transport*
 * surface and are intentionally hardcoded. Keep OS detection on `clientOs`
 * only; do not re-couple it to interface/header identity.
 *
 * Order matters: an Electron shell also satisfies browser heuristics, so the
 * bridge host is checked first, then the native Capacitor shell, then browser
 * heuristics. Safe to call before hydration: every helper falls through to
 * `false`/`undefined` without `window`/`navigator`.
 */
import { Capacitor } from "@capacitor/core";

import { getElectronBridge } from "@app/runtime/electron-bridge";
import { isNativePlatform } from "@app/runtime/native-platform";

export type ClientOs =
  | "macos"
  | "windows"
  | "linux"
  | "ios"
  | "android"
  | "web";

export function detectClientOs(): ClientOs {
  if (getElectronBridge()) {
    if (typeof navigator === "undefined") {
      return "web";
    }
    const platform = navigator.platform.toLowerCase();
    if (platform.includes("win")) {
      return "windows";
    }
    if (platform.includes("linux")) {
      return "linux";
    }
    return "macos";
  }
  if (isNativePlatform()) {
    // `isNativePlatform()` is true for the iOS AND Android Capacitor shells,
    // so distinguish them explicitly rather than assuming iOS.
    return Capacitor.getPlatform() === "android" ? "android" : "ios";
  }
  if (typeof navigator !== "undefined") {
    if (/iPhone|iPod/.test(navigator.userAgent)) {
      return "ios";
    }
    // iPadOS 13+ in desktop mode reports as Mac but keeps multitouch.
    if (
      /iPad/.test(navigator.userAgent) ||
      (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1)
    ) {
      return "ios";
    }
    if (/Android/i.test(navigator.userAgent)) {
      return "android";
    }
  }
  return "web";
}
