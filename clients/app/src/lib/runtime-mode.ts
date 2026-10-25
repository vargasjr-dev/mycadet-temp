import { readInjectedConfig } from "./injected-config";

/**
 * The serving host stamps the runtime truth: the cloud's served shell
 * carries remote "cloud"; the Capacitor stamps, the desktop shim, and every
 * self-hosted surface resolve to a local arm (or inject nothing at all, which
 * reads as local too).
 */
export function isLocalClient(): boolean {
  return readInjectedConfig()?.remote !== "cloud";
}
