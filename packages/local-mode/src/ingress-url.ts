/**
 * Gateway ingress notification: once ANYONE knows the gateway's public
 * base URL, the gateway learns it here — publisher-agnostic on purpose.
 * The tunnel dispatch (`cadet tunnel`'s tunnel level, or the daemon's
 * auto-tunnel) calls it when a provider has a public URL; the hatch layer
 * calls it right after leasing the guardian token, and the entry's own
 * gateway URL is what gets recorded, so the pairing mint reads a saved
 * address instead of falling back to the internal bind port. The caller's
 * tag (`publicBaseUrlManagedBy`) is the ownership marker the gateway's
 * tunnel reconcile keys on: a dead tunnel cannot clear a hatch-recorded
 * URL, and a live tunnel's publication supersedes one.
 */

import { getGatewayUrl } from "./lockfile-contract";
import { findAssistant } from "./operations/lookup";
import { loadGuardianToken } from "./guardian-token";
import { loopbackSafeFetch } from "./loopback-fetch";
import { DEFAULT_PORTS } from "./ports";

/**
 * Where the gateway for this run's assistant answers. The entry's recorded
 * loopback gateway port when one resolves; the global gateway port
 * otherwise. findAssistant resolves the bare spelling too (the operator
 * backend's active assistant), so the optional id rides straight in.
 */
function gatewayUrlFor(assistantId: string | undefined): string {
  const entry = findAssistant(assistantId);
  return entry
    ? getGatewayUrl(entry)
    : `http://127.0.0.1:${DEFAULT_PORTS.gateway}`;
}

/**
 * Tell the gateway the public URL to record as its ingress base — the same
 * route and config machinery its own tunnel machinery uses. The bearer is
 * always resolved from the assistant's token file here (the lease persists
 * it before its callers run). Best-effort: a gateway that is down never
 * fails the publisher that fronts it.
 */
export async function notifyGatewayOfPublicUrl(options: {
  publicUrl: string;
  assistantId?: string;
  /** The ownership tag; the gateway defaults to `tunnel`. */
  managedBy?: string;
  /** Overrides the default console.warn sink. */
  log?: (msg: string) => void;
}): Promise<void> {
  const log = options.log ?? console.warn;
  try {
    const token = options.assistantId
      ? loadGuardianToken(options.assistantId)?.accessToken
      : undefined;
    const res = await loopbackSafeFetch(
      `${gatewayUrlFor(options.assistantId).replace(/\/$/, "")}/v1/ingress/domains`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          publicBaseUrl: options.publicUrl,
          managedBy: options.managedBy ?? "tunnel",
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!res.ok) {
      throw new Error(`gateway responded ${res.status}`);
    }
  } catch (err) {
    log(
      `   ⚠ Could not record the ingress domain with the gateway: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }
}
