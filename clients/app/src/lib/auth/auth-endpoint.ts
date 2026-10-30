import { getElectronBridge } from "@app/runtime/electron-bridge";

/**
 * Same origin for both shapes: browsers ride their origin's `/v1` proxy,
 * and the Electron page origin serves `/_allauth` through the shell's own
 * cloud forward — the same-origin rule holds for the bridge too.
 */
export function authEndpoint(path: string): string {
  if (!getElectronBridge()) return `/_allauth/browser/v1/${path}`;
  return new URL(`/_allauth/app/v1/${path}`, window.location.origin).href;
}
