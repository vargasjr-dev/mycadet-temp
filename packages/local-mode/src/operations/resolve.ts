import { cloudAuthHeaders, readCloudToken } from "../cloud-auth";
import { checkHealth } from "../daemon-readiness";
import {
  getGatewayUrl,
  isCloudEntry,
  type CloudAssistant,
} from "../lockfile-contract";
import { loopbackSafeFetch } from "../loopback-fetch";
import { listAssistants } from "./list";
import type { OperatorRequest } from "./routes";

function resolutionResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function isCloudAssistantUnavailable(
  entry: CloudAssistant,
  callerHeaders: Headers,
): Promise<boolean> {
  try {
    const headers = new Headers({ Accept: "application/json" });
    for (const name of [
      "authorization",
      "cookie",
      "x-session-token",
      "cadet-organization-id",
    ]) {
      const value = callerHeaders.get(name);
      if (value) headers.set(name, value);
    }
    if (
      !headers.has("authorization") &&
      !headers.has("cookie") &&
      !headers.has("x-session-token")
    ) {
      const token = readCloudToken();
      if (token) {
        const tokenHeaders = await cloudAuthHeaders(token);
        for (const [name, value] of Object.entries(tokenHeaders)) {
          if (!headers.has(name)) headers.set(name, value);
        }
      }
    }
    const response = await loopbackSafeFetch(
      `${getGatewayUrl(entry)}/v1/assistants/${encodeURIComponent(entry.assistantId)}/`,
      { headers, redirect: "error", signal: AbortSignal.timeout(5000) },
    );
    if (response.status !== 410) return false;
    const body: unknown = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      "status" in body &&
      body.status === "unavailable"
    );
  } catch {
    return false;
  }
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
  const entry = request.assistant;
  if (!entry) {
    // Nothing resolves: the resolution's unscoped arm IS the list
    // contract — nothing hatched is empty, anything else hands the
    // choice rows to the account chooser.
    return listAssistants();
  }
  const health = await checkHealth(entry, { headers });
  if (!health.authenticated) {
    return resolutionResponse({ status: "unauthenticated" }, 401);
  }
  if (!health.version) {
    // Health alone cannot distinguish a stopped assistant from one retired
    // in the cloud while this machine still has its saved entry.
    if (
      isCloudEntry(entry) &&
      (await isCloudAssistantUnavailable(entry, headers))
    ) {
      return /^\/(?:v1|api)\/assistants\//.test(request.path)
        ? resolutionResponse({ status: "unavailable" }, 410)
        : listAssistants(entry.assistantId);
    }
    // The gateway answered nothing (unreachable, still booting, or
    // older than the identity payload) — the assistant is not ready to
    // mount. The 409 carries the verdict for clients that read codes;
    // the body names the arm for clients that read the union.
    return resolutionResponse({ status: "notReady" }, 409);
  }
  return resolutionResponse({
    status: "ready",
    assistant: {
      id: entry.assistantId,
      version: health.version,
    },
  });
}
