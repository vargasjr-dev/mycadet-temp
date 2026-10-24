import type { ClientOs } from "@app/runtime/client-os";

/**
 * True when the renderer runs inside the Electron host. Safe to call
 * server-side / before hydration — falls through to `false` when `window`
 * is not defined yet. App twin of web's `runtime/is-electron`.
 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && window.cadet?.platform === "electron";
}
