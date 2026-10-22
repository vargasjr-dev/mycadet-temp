import { isCloudHome } from "./cloud-values.js";
import { hostname } from "node:os";

import { getLocalLanIPv4 } from "./local";
import { getLoopbackGatewayPort } from "@mycadet/local-mode/contract";
import { GATEWAY_PORT } from "./constants.js";
import type { AssistantEntry } from "./assistant-config.js";

/**
 * Resolve the URL for a generic runtime endpoint under `/v1/<subpath>`,
 * taking the assistant's topology into account.
 *
 * - For local/docker assistants, `runtimeUrl` is the loopback gateway and
 *   the runtime serves `/v1/<subpath>` directly.
 * - For cloud-managed (cloud="cadet") assistants the path is rewritten
 *   to the wildcard runtime proxy:
 *   `{cloudUrl}/v1/assistants/<assistantId>/<subpath>`.
 *
 * The `subpath` is appended verbatim (e.g. `"identity"`).
 */
export function resolveRuntimeUrl(
  entry: Pick<AssistantEntry, "cloud" | "runtimeUrl" | "assistantId">,
  subpath: string,
): string {
  if (isCloudHome(entry.cloud)) {
    return `${entry.runtimeUrl}/v1/assistants/${entry.assistantId}/${subpath}`;
  }
  return `${entry.runtimeUrl}/v1/${subpath}`;
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
 * `candidateUrl` normalizes to the entry's persisted `runtimeUrl`.
 *
 * Returns the persisted URL that the candidate matched — never the
 * caller-supplied `candidateUrl` verbatim — so credentials only ever reach a
 * trusted origin even if a caller forgets to use this return value. Returns
 * `null` when the candidate is untrusted (caller must skip the refresh).
 */
export function trustedRefreshUrl(
  entry: AssistantEntry,
  candidateUrl: string,
): string | null {
  const candidate = normalizeRuntimeUrl(candidateUrl);
  const persisted = entry.runtimeUrl;
  if (persisted && normalizeRuntimeUrl(persisted) === candidate) {
    return persisted;
  }
  return null;
}

/** The URL to dial an entry's gateway on: its loopback gateway port, else its recorded runtimeUrl, else the default gateway port. */
export function getGatewayUrl(entry: AssistantEntry): string {
  const port = getLoopbackGatewayPort(entry);
  if (port) return `http://127.0.0.1:${port}`;
  return (entry.runtimeUrl || `http://127.0.0.1:${GATEWAY_PORT}`).replace(
    /\/+$/,
    "",
  );
}
