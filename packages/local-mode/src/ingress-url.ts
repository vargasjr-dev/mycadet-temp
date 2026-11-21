/**
 * The host's one-line ingress publication: tell an assistant's gateway the
 * public base URL its users' browsers dial, right after hatch leases the
 * guardian token. The gateway records it through the same route its tunnel
 * uses (POST /v1/ingress/domains → the shared `writeManagedPublicBaseUrl`
 * machinery), tagged `hatch` — the pairing mint then reads the saved URL
 * instead of falling back to the internal bind URL (the docker pair's
 * printed link pointed at the container port before this existed).
 *
 * The tag is the ownership marker: the tunnel's reconcile and loss
 * handling only touch `tunnel`-tagged URLs, so a dead tunnel cannot clear
 * a hatch-recorded one, and a live tunnel's publication supersedes it.
 *
 * Best-effort by design: a failed save only costs the freshly hatched
 * assistant its pairing-link precision — the mint's loopback fallback
 * answers, exactly as it did before this existed. The assistant is still
 * hatched either way.
 */
export async function saveIngressPublicBaseUrl(options: {
  gatewayUrl: string;
  bearerToken?: string;
  publicBaseUrl: string;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const log = options.log ?? (() => {});

  if (!options.bearerToken) {
    log(
      "⚠️  Ingress URL not recorded because the guardian token was not leased.\n" +
        "   Pairing still works — the link falls back to the gateway's default port.",
    );
    return;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      `${options.gatewayUrl.replace(/\/$/, "")}/v1/ingress/domains`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.bearerToken}`,
        },
        body: JSON.stringify({
          publicBaseUrl: options.publicBaseUrl,
          managedBy: "hatch",
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      `⚠️  Failed to record the ingress URL: ${message}\n` +
        "   Pairing still works — the link falls back to the gateway's default port.",
    );
  }
}
