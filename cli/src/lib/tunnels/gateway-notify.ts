/**
 * Tunnel-level gateway notification: once ANY tunnel provider has a public
 * URL, the gateway learns it here — ngrok-agnostic on purpose, so every
 * provider conforms by returning its `publicUrl` and the dispatch (`cadet
 * tunnel`'s tunnel level, or the daemon's auto-tunnel) calls this.
 */

import { lookupAssistantByIdentifier } from "../assistant-config.js";
import { GATEWAY_PORT } from "../constants.js";
import { loadGuardianToken } from "../guardian-token.js";
import { loopbackSafeFetch } from "../loopback-fetch.js";

/**
 * Where the gateway for this run's assistant answers. The entry's recorded
 * loopback URL when one resolves; the global gateway port otherwise.
 */
function gatewayUrlFor(assistantId: string | undefined): string {
  if (assistantId) {
    const result = lookupAssistantByIdentifier(assistantId);
    if (result.status === "found") {
      const url = result.entry.localUrl ?? result.entry.runtimeUrl;
      if (url) return url;
    }
  }
  return `http://127.0.0.1:${GATEWAY_PORT}`;
}

/**
 * Tell the gateway the tunnel's public URL so it records the ingress domain
 * in its own config, the same way its own tunnel machinery does. Best-effort:
 * a gateway that is down never fails the tunnel that fronts it.
 */
export async function notifyGatewayOfPublicUrl(
  publicUrl: string,
  assistantId: string | undefined,
): Promise<void> {
  try {
    const token = assistantId
      ? loadGuardianToken(assistantId)?.accessToken
      : undefined;
    const res = await loopbackSafeFetch(
      `${gatewayUrlFor(assistantId)}/v1/ingress/domains`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ publicBaseUrl: publicUrl }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!res.ok) {
      throw new Error(`gateway responded ${res.status}`);
    }
  } catch (err) {
    console.warn(
      `   ⚠ Could not record the ingress domain with the gateway: ${err instanceof Error ? err.message : String(err)}. The tunnel still runs.`,
    );
  }
}
