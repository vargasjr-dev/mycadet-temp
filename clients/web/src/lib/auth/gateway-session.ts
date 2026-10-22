import {
  isLocalClient,
  getLocalGatewayUrl,
  getPairedGatewayUrl,
  getSelectedAssistant,
  isServedGatewayRuntime,
} from "@/lib/local-mode";
import { getSelfHostedIngressUrl } from "@/lib/self-hosted/connection";

/**
 * Gateway session state. The renderer holds no gateway credential of its
 * own: in the local desktop mode the trusted host mints the bearer against
 * the loopback gateway from the on-disk guardian token and injects it on
 * its forwards, so nothing token-shaped ever reaches localStorage; paired
 * browsers ride the host-injected paired bearer the same way. This module
 * keeps the served-gateway arm's platform-exchanged token, the gateway-auth
 * predicates, and the scrubber that clears tokens persisted by older
 * clients.
 */

let remoteGatewayToken: string | null = null;
let remoteGatewayExpiresAt: number = 0;

export function isGatewayAuthEnabled(): boolean {
  if (isServedGatewayRuntime()) {
    return true;
  }
  if (!isLocalClient()) {
    return false;
  }
  return (
    getLocalGatewayUrl() != null ||
    getPairedGatewayUrl(getSelectedAssistant()) != null
  );
}

export function isGatewayAuthMode(): boolean {
  if (!isGatewayAuthEnabled()) {
    return false;
  }
  if (!isServedGatewayRuntime()) {
    const selectedAssistant = getSelectedAssistant();
    if (getPairedGatewayUrl(selectedAssistant) != null) {
      // The paired prime seeds the shared same-origin data-plane slot.
      return getSelfHostedIngressUrl() != null;
    }
    // The local signal is topology — a resolvable gateway URL — not token
    // presence: the trusted host owns bearer custody in this mode.
    return getLocalGatewayUrl() != null;
  }
  return getGatewayToken() !== null;
}

function isTokenExpired(expiresAt: number): boolean {
  return Date.now() / 1000 >= expiresAt - 60;
}

function toEpochSeconds(value: string | number): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1000 : 0;
  }
  return value > 1_000_000_000_000 ? value / 1000 : value;
}

export function setRemoteGatewayToken(params: {
  accessToken: string;
  accessTokenExpiresAt: string | number;
}): void {
  remoteGatewayToken = params.accessToken;
  remoteGatewayExpiresAt = toEpochSeconds(params.accessTokenExpiresAt);
}

export function getGatewayToken(): string | null {
  if (remoteGatewayToken && !isTokenExpired(remoteGatewayExpiresAt)) {
    return remoteGatewayToken;
  }
  remoteGatewayToken = null;
  remoteGatewayExpiresAt = 0;
  return null;
}

// Every spelling the gateway-session cache ever used, including the
// pre-cadet: prefixes the startup migration used to rename.
const SCRUB_KEYS = [
  "cadet:gw:token",
  "cadet:gw:expiresAt",
  "cadet:gw:tokenSource",
  "gw:token",
  "gw:expiresAt",
  "gw:tokenSource",
] as const;

/**
 * Drop any gateway bearer this renderer still holds: the in-memory served
 * token and every localStorage spelling older clients persisted. The host
 * owns bearer custody now, so this is pure hygiene — logout, assistant
 * switch, and upgrade flows call it to leave no stale credential behind.
 */
export function clearGatewayToken(): void {
  remoteGatewayToken = null;
  remoteGatewayExpiresAt = 0;
  try {
    for (const key of SCRUB_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage unavailable
  }
}
