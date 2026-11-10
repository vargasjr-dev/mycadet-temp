/**
 * The shared cloud hop: the gateway's assistant-plane arms forward a
 * request to the cloud on the assistant's own credentials.
 *
 * The bound cloud assistant UUID is used on the upstream path, not the
 * URL id (which may be `"self"` or a client-resolved slug). The cloud
 * authenticates the hop with the stored assistant API key. Arms built on
 * this helper: the push-token proxy and the assistant's public-identity
 * surface (handle claim, handle availability, domains).
 */

import { getCredentials } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { resolveCloudAssistantIdOrUndefined } from "../../cloud-identity.js";
import { getCloudBaseUrl } from "../../cloud-url.js";
import { errorResponse } from "../loopback-guard.js";

const log = getLogger("cloud-hop");

const UPSTREAM_TIMEOUT_MS = 10_000;

export interface CloudTarget {
  cloudBaseUrl: string;
  assistantApiKey: string;
  assistantId: string;
}

export async function resolveCloudTarget(): Promise<
  CloudTarget | Response
> {
  const [assistantApiKeyRaw, assistantId] = await Promise.all([
    getCredentials().get(credentialKey("cadet", "assistant_api_key")),
    resolveCloudAssistantIdOrUndefined(),
  ]);

  const cloudBaseUrl = getCloudBaseUrl();
  const assistantApiKey = assistantApiKeyRaw?.trim() || undefined;

  if (!cloudBaseUrl || !assistantApiKey || !assistantId) {
    return errorResponse(
      "PLATFORM_UNAVAILABLE",
      "This assistant is not registered with Cadet Cloud, so this surface is unavailable.",
      503,
    );
  }

  return { cloudBaseUrl, assistantApiKey, assistantId };
}

/**
 * Forward the caller's request to the cloud under
 * `/v1/assistants/{boundId}{resourcePath}`, answering the cloud's
 * status and body verbatim. `resourcePath` includes its leading slash and
 * trailing slash as the upstream route spells it (e.g. `/handle-available/`,
 * `/` for the assistant record itself).
 */
export async function forwardToCloud(
  req: Request,
  resourcePath: string,
): Promise<Response> {
  const target = await resolveCloudTarget();
  if (target instanceof Response) {
    return target;
  }

  const search = new URL(req.url).search;
  const upstreamUrl = `${target.cloudBaseUrl}/v1/assistants/${target.assistantId}${resourcePath}${search}`;

  const headers = new Headers();
  headers.set("Authorization", `Api-Key ${target.assistantApiKey}`);
  const contentType = req.headers.get("content-type");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }

  let body: ArrayBuffer | undefined;
  if (
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    req.method !== "DELETE"
  ) {
    body = await req.arrayBuffer();
  }

  try {
    const res = await fetchImpl(upstreamUrl, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!res.ok) {
      log.warn(
        { status: res.status, path: resourcePath },
        "Non-OK response from cloud endpoint",
      );
    }

    const responseHeaders = new Headers();
    const upstreamContentType = res.headers.get("content-type");
    if (upstreamContentType) {
      responseHeaders.set("content-type", upstreamContentType);
    }

    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders,
    });
  } catch (err) {
    log.warn(
      { err, path: resourcePath },
      "Failed to reach cloud endpoint",
    );
    return errorResponse(
      "PLATFORM_UNAVAILABLE",
      "Could not reach Cadet Cloud for this surface.",
      502,
    );
  }
}
