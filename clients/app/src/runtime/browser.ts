import { Capacitor } from "@capacitor/core";

import { getElectronBridge } from "@app/runtime/electron-bridge";

/**
 * Shared cross-shell open routing. Electron (external system browser) and
 * native Capacitor (`SFSafariViewController`) never unload the current page;
 * only the plain-web path varies, so callers supply the web fallback.
 *
 * The plugin is lazy-imported so it is never loaded in SSR or plain-browser
 * contexts where the Capacitor runtime is absent.
 */
const openUrlAcrossShells = async (
  url: string,
  webFallback: (url: string) => void,
): Promise<void> => {
  if (getElectronBridge()) {
    window.open(url, "_blank");
    return;
  }
  if (Capacitor.isNativePlatform()) {
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url, presentationStyle: "popover" });
    } catch {
      // Plugin not available (e.g. older app binary without @capacitor/browser
      // registered). Fall back to the web behaviour so checkout still works.
      webFallback(url);
    }
  } else {
    webFallback(url);
  }
};

/**
 * Opens a URL in the most appropriate context:
 * - Electron: system browser via the main-process `setWindowOpenHandler`
 *   (which routes `target=_blank` opens to `shell.openExternal`).
 * - Native (Capacitor): `SFSafariViewController` via `@capacitor/browser`,
 *   which keeps the user inside the app and properly handles OAuth / Stripe
 *   redirect flows that would otherwise break out to Safari.
 * - Web: falls back to `window.location.href` (same-tab navigation), matching
 *   the previous behaviour.
 */
export const openUrl = (url: string): Promise<void> =>
  openUrlAcrossShells(url, (u) => {
    window.location.href = u;
  });
