import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";

/**
 * Process-local proof that a loopback request was opened by this gateway's
 * Tunnel bridge. Direct callers can know the header name, but not the
 * per-process value.
 */
export const TUNNEL_BRIDGE_AUTH_HEADER = "x-cadet-tunnel-bridge-auth" as const;

const bridgeAuthValue = randomBytes(32).toString("base64url");

export function addTunnelBridgeAuthHeader(
  headers: OutgoingHttpHeaders,
): OutgoingHttpHeaders {
  headers[TUNNEL_BRIDGE_AUTH_HEADER] = bridgeAuthValue;
  return headers;
}

export function setTunnelBridgeAuthHeader(headers: Headers): void {
  headers.set(TUNNEL_BRIDGE_AUTH_HEADER, bridgeAuthValue);
}

export function requestHasTunnelBridgeAuth(req: Request): boolean {
  const value = req.headers.get(TUNNEL_BRIDGE_AUTH_HEADER);
  if (!value) return false;

  const actual = Buffer.from(value);
  const expected = Buffer.from(bridgeAuthValue);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
