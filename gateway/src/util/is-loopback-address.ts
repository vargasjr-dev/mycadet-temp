import type { Server } from "bun";

/**
 * Check whether the TCP peer of a Bun HTTP request is a loopback address.
 *
 * When `trustProxy` is set, `X-Forwarded-For` is consulted to recover the real
 * client behind a trusted reverse proxy — but ONLY when the raw socket peer is
 * itself loopback (i.e. the request actually arrived over the same-host proxy
 * hop). A direct connection from a non-loopback peer is never treated as
 * loopback, so a remote caller hitting a directly-exposed gateway port cannot
 * spoof `X-Forwarded-For: 127.0.0.1` to pass a loopback gate. (This assumes the
 * proxy overwrites client-supplied X-Forwarded-For, which is the documented
 * requirement for enabling trustProxy.)
 */
export function isLoopbackPeer(
  server: Server<unknown>,
  req: Request,
  opts?: { trustProxy?: boolean },
): boolean {
  const peer = server.requestIP(req);
  const peerIsLoopback = peer ? isLoopbackAddress(peer.address) : false;

  if (opts?.trustProxy) {
    // Direct (non-proxied) connection — don't trust X-Forwarded-For at all.
    if (!peerIsLoopback) return false;
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (!first) return false;
      return isLoopbackAddress(first);
    }
    // Loopback socket, no X-Forwarded-For → a genuinely local direct client.
    return true;
  }

  return peerIsLoopback;
}

/**
 * Strictly loopback-only check: accepts only 127.0.0.0/8 and ::1.
 */
export function isLoopbackAddress(addr: string): boolean {
  const v4Mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const normalized = v4Mapped ? v4Mapped[1] : addr;

  if (normalized.includes(".")) {
    const parts = normalized.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
    )
      return false;
    return parts[0] === 127;
  }

  return normalized.toLowerCase() === "::1";
}

/**
 * True when `addr` falls inside the IPv4 CIDR range `cidr` (e.g.
 * `172.18.0.0/16`). Unparseable inputs return false on both sides, so a
 * malformed config entry can only ever narrow acceptance, never widen it.
 */
export function isIpv4InCidr(addr: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (!range || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const toInt = (ip: string): number | null => {
    const parts = ip.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
    ) {
      return null;
    }
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  };

  const addrInt = toInt(addr);
  const rangeInt = toInt(range);
  if (addrInt === null || rangeInt === null) return false;

  // bits = 0 accepts everything; the mask math below handles it naturally.
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (addrInt & mask) === (rangeInt & mask);
}

/**
 * True when a request's peer address counts as "the local machine" for
 * loopback-only endpoints: the loopback interface itself, or a peer inside one
 * of the deployment's explicitly-trusted CIDR ranges.
 *
 * The trusted-CIDR path exists for containerized gateways, where docker's
 * published-port NAT rewrites every host-originated connection's source to
 * the instance network's bridge address — a strictly-loopback check can never
 * pass, no matter how local the caller is. The CLI stamps the instance
 * network's subnet into `GATEWAY_TRUSTED_PEER_CIDRS` at container create, so
 * the ranges cover exactly that instance's own containers plus the NAT'd host
 * traffic, and nothing routable from the internet.
 */
export function isTrustedLocalPeer(addr: string, cidrs: readonly string[]): boolean {
  if (isLoopbackAddress(addr)) return true;
  return cidrs.some((cidr) => isIpv4InCidr(addr, cidr));
}
