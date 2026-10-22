import {
  hasLocalGateway,
  hasPairedGateway,
  isLocalClient,
  getSelectedAssistant,
  isServedGatewayRuntime,
} from "@/lib/local-mode";
import { getSelfHostedIngressUrl } from "@/lib/self-hosted/connection";

/**
 * The served-gateway arm's platform-exchanged token, plus the gateway-auth
 * predicates. Bearer custody is host-side: nothing token-shaped reaches
 * localStorage.
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
  const assistant = getSelectedAssistant();
  return hasLocalGateway(assistant) || hasPairedGateway(assistant);
}

export function isGatewayAuthMode(): boolean {
  if (!isGatewayAuthEnabled()) {
    return false;
  }
  if (!isServedGatewayRuntime()) {
    const selectedAssistant = getSelectedAssistant();
    if (hasPairedGateway(selectedAssistant)) {
      // The paired prime seeds the shared same-origin data-plane slot.
      return getSelfHostedIngressUrl() != null;
    }
    // The local signal is topology — a resolvable gateway — not token
    // presence: the trusted host owns bearer custody in this mode.
    return hasLocalGateway(selectedAssistant);
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

/** Drop the in-memory served token (logout, assistant switch, upgrades). */
export function clearGatewayToken(): void {
  remoteGatewayToken = null;
  remoteGatewayExpiresAt = 0;
}
