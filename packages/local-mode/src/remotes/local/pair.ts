import { loopbackSafeFetch } from "../../loopback-fetch";
import { getGatewayUrl, type LockfileAssistant } from "../../lockfile-contract";
import type { PairOperationResult } from "../../operations/pair";

/**
 * Pair over the gateway's published loopback address (local topology — the
 * gateway runs on this host). Throws on a non-OK response.
 */
export async function pairLocal(
  entry: LockfileAssistant,
  body: string,
): Promise<PairOperationResult> {
  const response = await loopbackSafeFetch(`${getGatewayUrl(entry)}/v1/pair`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cadet-Interface-Id": "cli",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    return { ok: false, status: response.status, error: text };
  }
  return { ok: true, response: await response.json() };
}
