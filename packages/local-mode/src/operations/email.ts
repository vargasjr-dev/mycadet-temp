/**
 * The email OPERATOR routes: the assistant's mail surface — the message
 * list, the email addresses, and the sending domains — served host-side
 * on the operator's own credentials (the doctor rows' pattern). The web
 * bundle's inbox and the logs tab used to dial the cloud directly on the
 * browser's session; now every dial is a verbatim proxy to the cloud at
 * the entry's cloud registration, so the browser never needs a cloud
 * session to read mail.
 */

import { loopbackSafeFetch } from "../loopback-fetch";
import type { LockfileAssistant } from "../lockfile-contract";
import { findAssistantByName } from "./lookup";
import type { OperatorRequest } from "./routes";
import {
  UPSTREAM_TIMEOUT_MS,
  cloudOrigin,
  operatorCloudHeaders,
  operatorError,
  readOperatorCloudToken,
} from "./cloud-proxy";

/**
 * Proxy one email dial to the cloud at the entry's cloud registration —
 * the same shape as every non-streaming doctor dial.
 */
async function proxyToCloud(
  request: OperatorRequest,
  tailPath: string,
): Promise<Response | null> {
  const entry = findAssistantByName(request.assistantId);
  if (!entry) {
    return null;
  }
  const cloudAssistantId = cloudAssistantIdFor(entry);
  if (!cloudAssistantId) {
    return operatorError(
      "This assistant is not registered with Cadet Cloud, so its mail is unavailable.",
      503,
    );
  }
  const token = readOperatorCloudToken();
  if (!token) {
    return operatorError(
      "Not logged in to Cadet Cloud, so the mail surface is unavailable.",
      401,
    );
  }

  const headers: Record<string, string> = operatorCloudHeaders(entry, token);
  const callerHeaders = new Headers(request.headers as HeadersInit | undefined);
  const contentType = callerHeaders.get("content-type");
  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  try {
    return await loopbackSafeFetch(
      `${cloudOrigin()}/v1/assistants/${encodeURIComponent(cloudAssistantId)}${tailPath}`,
      {
        method: request.method ?? "GET",
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : request.body
              ? await new Response(request.body).text()
              : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch (err) {
    console.warn(
      `[email] cloud dial failed (${tailPath}):`,
      err instanceof Error ? err.message : err,
    );
    return operatorError("Could not reach Cadet Cloud for the mail surface.", 502);
  }
}

/**
 * The cloud registration a mail dial addresses: the entry's cloud
 * registration UUID when the entry holds one; a cloud-hosted entry IS its
 * assistant id. An entry with neither was never registered with the cloud,
 * and the cloud-run mail surface has nothing to dial.
 */
function cloudAssistantIdFor(entry: LockfileAssistant): string | null {
  if (entry.cloudAssistantId?.trim()) return entry.cloudAssistantId.trim();
  if (entry.cloud === "cloud") return entry.assistantId;
  return null;
}

/** The list rows carry the query string through untouched. */
function searchFrom(path: string): string {
  return path?.includes("?") ? path.slice(path.indexOf("?")) : "";
}

/** Pull one path segment out of the request path's tail. */
function tailSegment(path: string, prefix: string): string | null {
  const match = new RegExp(
    `\\/${prefix}\\/([^\\/?#]+)\\/?$`,
  ).exec(path);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export async function runEmailsListRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  return proxyToCloud(request, `/emails/${searchFrom(request.path ?? "")}`);
}

export async function runEmailAddressesListRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  return proxyToCloud(
    request,
    `/email-addresses/${searchFrom(request.path ?? "")}`,
  );
}

export async function runEmailAddressesCreateRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  return proxyToCloud(request, "/email-addresses/");
}

export async function runEmailAddressesDestroyRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const address = tailSegment(request.path ?? "", "email-addresses");
  if (!address) {
    return null;
  }
  return proxyToCloud(
    request,
    `/email-addresses/${encodeURIComponent(address)}/`,
  );
}

export async function runEmailAddressesStatusRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const addressId = tailSegment(request.path ?? "", "email-addresses");
  if (!addressId) {
    return null;
  }
  return proxyToCloud(
    request,
    `/email-addresses/${encodeURIComponent(addressId)}/status/`,
  );
}

export async function runDomainsListRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  return proxyToCloud(request, `/domains/${searchFrom(request.path ?? "")}`);
}

export async function runDomainsCreateRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  return proxyToCloud(request, "/domains/");
}

export async function runDomainsDestroyRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const domain = tailSegment(request.path ?? "", "domains");
  if (!domain) {
    return null;
  }
  return proxyToCloud(request, `/domains/${encodeURIComponent(domain)}/`);
}

export async function runDomainsVerificationStatusRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const domainId = tailSegment(request.path ?? "", "domains");
  if (!domainId) {
    return null;
  }
  return proxyToCloud(
    request,
    `/domains/${encodeURIComponent(domainId)}/verification-status/`,
  );
}

export async function runDomainsProvisionRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const domainId = tailSegment(request.path ?? "", "domains");
  if (!domainId) {
    return null;
  }
  return proxyToCloud(
    request,
    `/domains/${encodeURIComponent(domainId)}/provision/`,
  );
}
