import { isCloudHome } from "./cloud-values.js";
import { hostname } from "node:os";

import { getLocalLanIPv4 } from "./lan-ip.js";
import { getLoopbackGatewayPort } from "@mycadet/local-mode/contract";
import { getCloudUrl } from "./cloud-client.js";
import { GATEWAY_PORT } from "./constants.js";
import type { LockfileAssistant } from "./assistant-config.js";

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
  if (isCloudHome(entry.cloud)) {
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

/**
 * SECURITY: decide whether a guardian-token refresh may be sent to
 * `candidateUrl`, and to which URL it should actually go.
 *
 * `cadet client` lets `--url`/`-u` override the runtime URL while still reusing
 * the selected entry's stored guardian token, so a victim pointed at an
 * attacker-controlled (or poisoned/redirected) URL must NOT cause us to POST the
 * long-lived refreshToken + deviceId there. Refresh is permitted only when
 * `candidateUrl` normalizes to the entry's own gateway address — the one
 * {@link getGatewayUrl} derives.
 *
 * Returns the trusted gateway URL that the candidate matched — never the
 * caller-supplied `candidateUrl` verbatim — so credentials only ever reach a
 * trusted origin even if a caller forgets to use this return value. Returns
 * `null` when the candidate is untrusted (caller must skip the refresh).
 */
export function trustedRefreshUrl(
  entry: LockfileAssistant,
  candidateUrl: string,
): string | null {
  const candidate = normalizeRuntimeUrl(candidateUrl);
  const trusted = getGatewayUrl(entry);
  if (normalizeRuntimeUrl(trusted) === candidate) {
    return trusted;
  }
  return null;
}

/**
 * The URL to dial an entry's gateway on, derived from the entry's canonical
 * fields — the one seam every consumer addresses a gateway through:
 *
 * - `custom` remotes: their recorded host and port.
 * - cloud-managed: the cloud URL the entry was hatched under (falling back
 *   to the environment's own resolution).
 * - loopback topologies (`local`, `docker`, `apple-container`): the
 *   recorded loopback gateway port, else the default gateway port.
 *
 * The recorded `runtimeUrl` only survives as a last resort for entries
 * whose canonical fields predate this resolver; it is scheduled to die
 * once every consumer reads through here.
 */
export function getGatewayUrl(entry: LockfileAssistant): string {
  if (entry.cloud === "custom" && entry.ipAddress && entry.port) {
    return `http://${entry.ipAddress}:${entry.port}`;
  }
  if (isCloudHome(entry.cloud)) {
    return (entry.runtimeUrl || getCloudUrl()).replace(/\/+$/, "");
  }
  const port = getLoopbackGatewayPort(entry);
  if (port) return `http://127.0.0.1:${port}`;
  return (entry.runtimeUrl || `http://127.0.0.1:${GATEWAY_PORT}`).replace(
    /\/+$/,
    "",
  );
}
