import { isCloudEntry } from "@mycadet/local-mode/contract";
import { hostname } from "node:os";

import { getLocalLanIPv4 } from "./lan-ip.js";
import { getGatewayUrl } from "@mycadet/local-mode/contract";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

/**
 * Resolve the URL for a generic runtime endpoint under `/v1/<subpath>`,
 * taking the assistant's topology into account.
 *
 * - For loopback assistants (local/docker/apple-container), the gateway
 *   serves `/v1/<subpath>` directly.
 * - For cloud-managed assistants the path is rewritten to the wildcard
 *   runtime proxy: `{cloudUrl}/v1/assistants/<assistantId>/<subpath>`.
 *
 * The address always derives through {@link getGatewayUrl}; the `subpath`
 * is appended verbatim (e.g. `"identity"`).
 */
export function resolveRuntimeUrl(
  entry: LockfileAssistant,
  subpath: string,
): string {
  if (isCloudEntry(entry)) {
    return `${getGatewayUrl(entry)}/v1/assistants/${entry.assistantId}/${subpath}`;
  }
  return `${getGatewayUrl(entry)}/v1/${subpath}`;
}

/**
 * If the hostname in `url` matches this machine's local DNS name, LAN IP, or
 * raw hostname, replace it with 127.0.0.1 so the client avoids mDNS round-trips
 * when talking to an assistant running on the same machine. Trailing slashes are
 * stripped on a swap. Returns the input unchanged if it doesn't parse as a URL.
 */
function maybeSwapToLocalhost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const urlHost = parsed.hostname.toLowerCase();

  const localNames: string[] = [];

  const host = hostname();
  if (host) {
    localNames.push(host.toLowerCase());
    // Also consider the bare name without .local suffix
    if (host.toLowerCase().endsWith(".local")) {
      localNames.push(host.toLowerCase().slice(0, -".local".length));
    }
  }

  const lanIp = getLocalLanIPv4();
  if (lanIp) {
    localNames.push(lanIp);
  }

  if (localNames.includes(urlHost)) {
    parsed.hostname = "127.0.0.1";
    return parsed.toString().replace(/\/+$/, "");
  }

  return url;
}

/**
 * Canonical form of a runtime/base URL used throughout the CLI: trailing
 * slashes stripped, then localhost-swapped. This is exactly the transform
 * `cadet client` applies to the runtime URL it hands the TUI, so comparing two
 * URLs after passing both through this function is a like-for-like comparison.
 */
export function normalizeRuntimeUrl(url: string): string {
  return maybeSwapToLocalhost(url.replace(/\/+$/, ""));
}
