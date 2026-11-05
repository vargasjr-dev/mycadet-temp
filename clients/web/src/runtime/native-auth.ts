import { Capacitor } from "@capacitor/core";
import { useSyncExternalStore } from "react";


/**
 * Platform detection for the Capacitor shells.
 *
 * This bundle never starts a login — the app bundle owns the auth flows and
 * hands the resulting session over (see `clients/app/src/runtime/native-login.ts`).
 */
/**
 * True when we're running inside a Capacitor native shell. Safe to call
 * server-side, so it falls through to `false` before hydration.
 */
export function isNativePlatform(): boolean {
  return typeof window !== "undefined" && Capacitor.isNativePlatform();
}

/**
 * Hook form of `isNativePlatform()`, safe to call from a render body.
 *
 * The value is correct on the very first render and constant thereafter:
 * Capacitor injects `native-bridge.js` as a `WKUserScript` at
 * `.atDocumentStart`, so `window.Capacitor` exists before this bundle
 * executes. `subscribe` is a noop because nothing can change the value, and
 * the `getServerSnapshot` argument is unreachable because `clients/web`
 * renders client-only through `createRoot` (no SSR, no hydration).
 *
 * Prefer it over the bare function in JSX (docs/CAPACITOR.md): it keeps the
 * shape consistent with the cloud hooks in `runtime/platform-detection.ts`
 * and stays correct if a prerender step is ever added. There is no first-paint
 * flicker to avoid.
 */
const noop = () => () => {};
export function useIsNativePlatform(): boolean {
  return useSyncExternalStore(noop, isNativePlatform, () => false);
}

