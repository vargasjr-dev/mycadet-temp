/**
 * The doctor OPERATOR routes: the doctor's whole session surface, served
 * host-side so the panel keeps working when the entry's gateway is
 * completely offline — that offline-diagnosis scenario is the doctor's
 * main use case, which is why the doctor lives here and not on the
 * gateway's assistant plane.
 *
 * The cloud runs the doctor (sessions, persisted history, event streams),
 * so every row is a verbatim proxy to the cloud on the OPERATOR's own
 * credentials: the lockfile entry's cloud registration ids address the
 * assistant, and the operator's token (env, else the on-disk cloud token)
 * authenticates the dial. The event stream is the one long-lived surface —
 * its dial binds to the caller's disconnect signal instead of a timeout,
 * and the session's replay cursor rides through as a `Last-Event-ID`
 * header.
 */

import { authHeadersForKnownOrganization } from "../cloud-auth";
import { loopbackSafeFetch } from "../loopback-fetch";
import type { LockfileAssistant } from "../lockfile-contract";
import { readCloudToken, resolveCloudUrl } from "../cloud-auth";
import { findAssistantByName } from "./lookup";
import type { OperatorRequest } from "./routes";

const UPSTREAM_TIMEOUT_MS = 10_000;

/** The env token, else the on-disk cloud token (the retire leg's order). */
function readOperatorCloudToken(): string | null {
  const envToken = (
    process.env.CADET_CLOUD_TOKEN ?? process.env.CADET_PLATFORM_TOKEN
  )?.trim();
  return envToken || readCloudToken();
}

/** The cloud's error body shape the bundles' error parsing already reads. */
function doctorError(detail: string, status: number): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The cloud assistant id a doctor dial addresses: the entry's cloud
 * registration UUID when the entry holds one; a cloud-hosted entry IS its
 * assistant id. An entry with neither was never registered with the cloud,
 * and the cloud-run doctor has nothing to dial.
 */
function cloudAssistantIdFor(entry: LockfileAssistant): string | null {
  if (entry.cloudAssistantId?.trim()) return entry.cloudAssistantId.trim();
  if (entry.cloud === "cloud") return entry.assistantId;
  return null;
}

/**
 * Proxy one doctor dial to the cloud. `streaming` marks the event stream:
 * no timeout, the caller's disconnect tears the upstream dial down.
 */
async function proxyToCloud(
  request: OperatorRequest,
  tailPath: string,
  opts?: { streaming?: boolean },
): Promise<Response | null> {
  const entry = findAssistantByName(request.assistantId);
  if (!entry) {
    return null;
  }
  const cloudAssistantId = cloudAssistantIdFor(entry);
  if (!cloudAssistantId) {
    return doctorError(
      "This assistant is not registered with Cadet Cloud, so the doctor is unavailable.",
      503,
    );
  }
  const token = readOperatorCloudToken();
  if (!token) {
    return doctorError(
      "Not logged in to Cadet Cloud, so the doctor is unavailable.",
      401,
    );
  }

  const headers: Record<string, string> = entry.cloudOrganizationId?.trim()
    ? authHeadersForKnownOrganization(token, entry.cloudOrganizationId.trim())
    : { Authorization: `Bearer ${token}` };
  const callerHeaders = new Headers(
    request.headers as HeadersInit | undefined,
  );
  const lastEventId = callerHeaders.get("last-event-id");
  if (lastEventId) {
    headers["Last-Event-ID"] = lastEventId;
  }
  const contentType = callerHeaders.get("content-type");
  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  try {
    return await loopbackSafeFetch(
      `${resolveCloudUrl().replace(/\/+$/, "")}/v1/assistants/${encodeURIComponent(cloudAssistantId)}${tailPath}`,
      {
        method: request.method ?? "GET",
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : request.body
              ? await new Response(request.body).text()
              : undefined,
        signal: opts?.streaming
          ? (request.signal ?? undefined)
          : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch (err) {
    console.warn(
      `[doctor] cloud dial failed (${tailPath}):`,
      err instanceof Error ? err.message : err,
    );
    return doctorError("Could not reach Cadet Cloud for the doctor.", 502);
  }
}

/** Pull the session id out of the request path's doctor tail. */
function sessionIdFrom(path: string, suffix: string): string | null {
  const match = new RegExp(
    `\\/doctor\\/sessions\\/([^\\/?#]+)\\/${suffix}\\/?$`,
  ).exec(path);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** The destroy tail ends at the session id — no suffix segment follows. */
function sessionIdFromBarePath(path: string): string | null {
  const match = /\/doctor\/sessions\/([^\/?#]+)\/?$/.exec(path);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export async function runDoctorHistoryListRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const search = request.path?.includes("?")
    ? request.path.slice(request.path.indexOf("?"))
    : "";
  return proxyToCloud(request, `/doctor/history/${search}`);
}

export async function runDoctorHistoryRetrieveRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const match = /\/doctor\/history\/([^\/?#]+)\/?$/.exec(request.path ?? "");
  if (!match?.[1]) {
    return null;
  }
  return proxyToCloud(
    request,
    `/doctor/history/${encodeURIComponent(decodeURIComponent(match[1]))}/`,
  );
}

export async function runDoctorSessionsCreateRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  return proxyToCloud(request, "/doctor/sessions/");
}

export async function runDoctorSessionsDestroyRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const sessionId = sessionIdFromBarePath(request.path ?? "");
  if (!sessionId) {
    return null;
  }
  return proxyToCloud(
    request,
    `/doctor/sessions/${encodeURIComponent(sessionId)}/`,
  );
}

export async function runDoctorSessionsEventsRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const sessionId = sessionIdFrom(request.path ?? "", "events");
  if (!sessionId) {
    return null;
  }
  return proxyToCloud(
    request,
    `/doctor/sessions/${encodeURIComponent(sessionId)}/events/`,
    { streaming: true },
  );
}

export async function runDoctorSessionsMessagesRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const sessionId = sessionIdFrom(request.path ?? "", "messages");
  if (!sessionId) {
    return null;
  }
  return proxyToCloud(
    request,
    `/doctor/sessions/${encodeURIComponent(sessionId)}/messages/`,
  );
}

export async function runDoctorSessionsUserOutcomeRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const sessionId = sessionIdFrom(request.path ?? "", "user-outcome");
  if (!sessionId) {
    return null;
  }
  return proxyToCloud(
    request,
    `/doctor/sessions/${encodeURIComponent(sessionId)}/user-outcome/`,
  );
}
