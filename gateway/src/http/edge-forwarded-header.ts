/**
 * Edge-observed client address, stamped by the same nginx edge on every
 * proxied request (`proxy_set_header X-Cadet-Client-Ip ...`, which REPLACES
 * any client-supplied value, so it cannot be smuggled). The edge derives it
 * from the rightmost `X-Forwarded-For` entry written by the TLS-terminating
 * front, falling back to its raw peer address when the front sets none.
 *
 * Only meaningful on requests that provably arrived via the trusted edge
 * (edge marker present AND loopback raw peer); read it nowhere else.
 */
export const EDGE_CLIENT_IP_HEADER = "x-cadet-client-ip" as const;
