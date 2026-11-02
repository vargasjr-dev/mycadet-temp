import { resolveCloudUrl } from "../cloud-auth";
import { getGatewayHealth } from "../daemon-readiness";
import { readLockfile } from "../lockfile";
import { loopbackSafeFetch } from "../loopback-fetch";
import type { LockfileAssistant } from "../lockfile-contract";
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
 * is served (empty, a choice list, or a specific entry), and the entry
 * itself says who it is and whether the CALLER's credentials authenticate.
 *
 * Like every operation it switches on the entry's remote: a loopback
 * gateway entry (local, docker, apple-container, custom, baseten) rides the
 * entry's own gateway `/healthz` — version + verdict in one round-trip, the
 * caller's headers forwarded so an authed gateway judges the browser, not
 * the host. A cloud entry has no host-side gateway: the platform's own
 * detail carries the arms, and the operation normalizes it into the same
 * union.
 */
export async function runResolveRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const headers = Object.fromEntries(request.headers ?? new Headers());
  if (!request.assistantId) {
    // No id to name (the lockfile has no active or sole entry): the
    // lockfile's own shape decides the arm — nothing hatched is empty,
    // anything else hands the choice rows to the account chooser.
    const lockfile = readLockfile();
    if (lockfile.assistants.length === 0) {
      return resolutionResponse({ status: "empty" });
    }
    return resolutionResponse({
      status: "selection",
      assistants: lockfile.assistants.map((entry) => ({
        id: entry.assistantId,
        ...(entry.name ? { name: entry.name } : {}),
        remote: entry.cloud,
      })),
    });
  }
  const entry = findAssistantByName(request.assistantId);
  if (!entry) {
    // Not this host's to name: the pre-existing chain answers — the cloud
    // 404s a stale id, the data-plane forward owns a platform-hosted one.
    return null;
  }
  switch (entry.cloud) {
    case "cloud": {
      // The platform's own detail for a cloud entry, normalized into the
      // resolution union. The cloud's status codes carry the arms the shell
      // renders — 401 no session, 409 still provisioning, 410 gone — and
      // its 200 detail carries the identity; the operation translates so
      // every surface answers the SAME union shape.
      const detailUrl = `${resolveCloudUrl()}/v1/assistants/${encodeURIComponent(entry.assistantId)}/`;
      try {
        const response = await loopbackSafeFetch(detailUrl, {
          headers: { Accept: "application/json", ...headers },
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 401) {
          return resolutionResponse({ status: "unauthenticated" });
        }
        if (response.status === 409) {
          return resolutionResponse({ status: "notReady" });
        }
        if (response.status === 410) {
          return resolutionResponse({ status: "unavailable" });
        }
        if (!response.ok) {
          return resolutionResponse({ status: "notReady" });
        }
        const detail = (await response.json().catch(() => null)) as {
          id?: unknown;
          version?: unknown;
          url?: unknown;
        } | null;
        if (
          typeof detail?.id !== "string" ||
          typeof detail.version !== "string" ||
          typeof detail.url !== "string"
        ) {
          return resolutionResponse({ status: "notReady" });
        }
        return resolutionResponse({
          status: "ready",
          assistant: { id: detail.id, version: detail.version, url: detail.url },
        });
      } catch {
        return resolutionResponse({ status: "notReady" });
      }
    }
    default: {
      // The entry's own gateway: identity and the caller's verdict in one
      // `/healthz` round-trip.
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
          url: "assistant/",
        },
      });
    }
  }
}

/** The entry shapes the resolution's switch handles, for tests. */
export type ResolvableEntry = LockfileAssistant;
