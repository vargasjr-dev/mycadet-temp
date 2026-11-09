/**
 * Proxy the platform's user-account surface (the user's profile).
 *
 * The web bundle's profile card used to dial the platform's `/v1/user/me/`
 * and `/v1/user/username-available/` directly (the old cloud client). Per
 * the cloud-client census, the user's profile is an assistant API the
 * assistant tracks for the user: the web dials the gateway, and the gateway
 * forwards to the platform, authenticating the hop with the stored
 * assistant API key — the same shape as cloud-push-proxy.
 *
 * Upstream DRF error bodies (409 taken, 400 invalid field errors) pass
 * through verbatim so the web's field-error parser keeps working unchanged.
 */

import { z } from "zod";

import { getCredentials } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { getCloudBaseUrl } from "../../cloud-url.js";
import { errorResponse } from "../loopback-guard.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("user-profile-proxy");

const UPSTREAM_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Spec schemas — mirror the platform's DRF serializers
// ---------------------------------------------------------------------------

export const UserProfileSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  first_name: z.string(),
  last_name: z.string(),
});

export const UserProfilePatchSchema = z
  .object({
    username: z.string().min(1).optional(),
  })
  .strict();

/**
 * The platform's canonical handle error codes — mirrors the web bundle's
 * `UsernameErrorCode` union (domains/account/profile.ts) so the codegen'd
 * type slots straight into the existing error-copy map.
 */
export const USERNAME_ERROR_CODES = [
  "too_short",
  "too_long",
  "invalid_chars",
  "leading_underscore",
  "trailing_underscore",
  "leading_hyphen",
  "trailing_hyphen",
  "all_digits",
  "reserved",
  "taken",
] as const;

export const UsernameAvailabilitySchema = z.object({
  available: z.boolean(),
  code: z.enum(USERNAME_ERROR_CODES).nullable(),
  message: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

interface PlatformTarget {
  cloudBaseUrl: string;
  assistantApiKey: string;
}

async function resolvePlatformTarget(): Promise<PlatformTarget | Response> {
  const assistantApiKeyRaw = await getCredentials().get(
    credentialKey("cadet", "assistant_api_key"),
  );
  const cloudBaseUrl = getCloudBaseUrl();
  const assistantApiKey = assistantApiKeyRaw?.trim() || undefined;

  if (!cloudBaseUrl || !assistantApiKey) {
    return errorResponse(
      "PLATFORM_UNAVAILABLE",
      "This assistant is not registered with Cadet Cloud, so the account profile is unavailable.",
      503,
    );
  }

  return { cloudBaseUrl, assistantApiKey };
}

async function forward(req: Request, resourcePath: string): Promise<Response> {
  const target = await resolvePlatformTarget();
  if (target instanceof Response) {
    return target;
  }

  const search = new URL(req.url).search;
  const upstreamUrl = `${target.cloudBaseUrl}${resourcePath}${search}`;

  const headers = new Headers();
  headers.set("Authorization", `Api-Key ${target.assistantApiKey}`);
  const contentType = req.headers.get("content-type");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }

  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
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
        "Non-OK response from platform user-profile endpoint",
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
      "Failed to reach platform user-profile endpoint",
    );
    return errorResponse(
      "PLATFORM_UNAVAILABLE",
      "Could not reach Cadet Cloud to load the account profile.",
      502,
    );
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Cloud-owned user-account surface. The web bundle hits these
// same-origin through the gateway; without a dedicated route they
// fall through to the runtime-proxy catch-all and 404.
export function handleUserMeGet(req: Request): Promise<Response> {
  return forward(req, "/v1/user/me/");
}

export function handleUserMePatch(req: Request): Promise<Response> {
  return forward(req, "/v1/user/me/");
}

export function handleUsernameAvailableGet(req: Request): Promise<Response> {
  return forward(req, "/v1/user/username-available/");
}

export const ROUTES: RouteDefinition[] = [
  {
    path: "/user/me",
    method: "get",
    operationId: "userMeGet",
    summary: "Get the user's account profile",
    description:
      "The assistant tracks the user's platform profile for them — " +
      "forwarded to the platform with the assistant's credentials.",
    tags: ["settings"],
    responseBody: UserProfileSchema,
    auth: "edge-scoped",
    scope: "settings.read",
    scoped: true,
    handler: (req) => handleUserMeGet(req),
  },
  {
    path: "/user/me",
    method: "patch",
    operationId: "userMePartialUpdate",
    summary: "Update the user's account profile",
    description:
      "Currently the username (handle). Upstream DRF field errors pass " +
      "through verbatim (409 taken, 400 invalid).",
    tags: ["settings"],
    requestBody: UserProfilePatchSchema,
    responseBody: UserProfileSchema,
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: (req) => handleUserMePatch(req),
  },
  {
    path: "/user/username-available",
    method: "get",
    operationId: "userUsernameAvailableGet",
    summary: "Check username availability",
    description:
      "Live availability check against the platform's global handle " +
      "namespace, forwarded with the assistant's credentials.",
    tags: ["settings"],
    queryParameters: [{ name: "username", description: "The candidate handle" }],
    responseBody: UsernameAvailabilitySchema,
    auth: "edge-scoped",
    scope: "settings.read",
    scoped: true,
    handler: (req) => handleUsernameAvailableGet(req),
  },
];
