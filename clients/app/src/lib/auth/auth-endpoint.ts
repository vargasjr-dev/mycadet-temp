import { getElectronBridge } from "@app/runtime/electron-bridge";

/**
 * Browser clients use their same-origin proxy. The native bridge has no
 * origin to serve `/v1` at, so it dials the stamped base directly — the
 * same-origin-vs-stamped distinction lives in the shells' proxy layers,
 * not here.
 */
export function authEndpoint(path: string): string {
  if (!getElectronBridge()) return `/_allauth/browser/v1/${path}`;
  return new URL(`/_allauth/app/v1/${path}`, window.location.origin).href;
}
