import { getGatewayHealth } from "../daemon-readiness";
import { runListRoute } from "./list";
import { findAssistantByName } from "./lookup";
import type { OperatorRequest } from "./routes";

function resolutionResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The shell's resolution operation. One `GET` on the assistant reference —
 * scoped to an id, or unscoped for the active assistant — answers the whole
 * resolution union so the app's hook is one fetch: the lockfile says what
 * is served (empty, a choice list, or a specific entry), and the health
 * check is remote agnostic — the entry's own gateway address is resolved
 * from the lockfile (the platform's ingress for a cloud entry, the loopback
 * gateway for a self-hosted one), and its `/healthz` answers identity and
 * the CALLER's auth verdict in one round-trip.
 */
export async function runResolveRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const headers = request.headers;
  if (!request.assistantId) {
    // No id to name: the resolution's unscoped arm IS the list contract —
    // nothing hatched is empty, anything else hands the choice rows to the
    // account chooser.
    return runListRoute();
  }
  const entry = findAssistantByName(request.assistantId);
  if (!entry) {
    // Not this host's to name: the pre-existing chain answers — the cloud
    // 404s a stale id, the data-plane forward owns a platform-hosted one.
    return null;
  }
  const health = await getGatewayHealth(entry, { headers });
  if (!health.authenticated) {
    return resolutionResponse({ status: "unauthenticated" });
  }
  if (!health.version) {
    // The gateway answered nothing (unreachable, still booting, or
    // older than the identity payload) — the assistant is not ready to
    // mount.
    return resolutionResponse({ status: "notReady" });
  }
  return resolutionResponse({
    status: "ready",
    assistant: {
      id: entry.assistantId,
      version: health.version,
    },
  });
}
