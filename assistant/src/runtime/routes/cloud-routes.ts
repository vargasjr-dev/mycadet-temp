/**
 * Cloud route handlers for the shared HTTP/IPC route table.
 *
 * Serves six operations:
 *   - cloud_status (GET cloud/status): aggregates cloud context,
 *     credentials, assistant ID, and webhook secret. (Tunnel status
 *     lives on the gateway — see gateway_status.)
 *   - cloud_connect (POST cloud/connect): reports whether the stored
 *     credentials still connect, and when the stored key has been rejected,
 *     says so, so the caller can tell the user what replaces it.
 *   - cloud_verify_credential (POST cloud/verify-credential): asks the
 *     cloud whether the stored assistant API key still authenticates.
 *   - cloud_disconnect (POST cloud/disconnect): deletes stored cloud
 *     credentials and emits cloud_disconnected signal.
 *   - cloud_callback_routes_register (POST cloud/callback-routes/register):
 *     registers a callback route with the cloud gateway.
 *   - cloud_callback_routes_list (GET cloud/callback-routes): lists
 *     registered callback routes for this assistant.
 */

import {
  type CloudCredentialVerificationStatus,
  type CloudVerifyCredentialResponse,
  CloudVerifyCredentialResponseSchema,
} from "@mycadet/service-contracts/cloud-credential";
import { z } from "zod";

import {
  resolveCloudOrganizationId,
  resolveCloudUserId,
} from "../../config/cloud-identity.js";
import {
  getCloudBaseUrl,
  setCloudAssistantId,
  setCloudOrganizationId,
  setCloudUserId,
} from "../../config/env.js";
import { getIsCloud } from "../../config/env-registry.js";
import {
  registerCallbackRoute,
  resolveCloudCallbackRegistrationContext,
} from "../../inbound/cloud-callback-registration.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getExistingDeviceId } from "../../util/device-id.js";
import { broadcastMessage } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS, LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadRequestError,
  InternalError,
  UnprocessableEntityError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Credential store keys
// ---------------------------------------------------------------------------

const CREDENTIAL_KEYS = {
  apiKey: { service: "cadet", field: "assistant_api_key" },
} as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CloudStatusResponseSchema = z.object({
  isCloud: z.boolean(),
  baseUrl: z.string(),
  assistantId: z.string(),
  hasAssistantApiKey: z
    .boolean()
    .nullable()
    .describe(
      "Whether a cloud assistant API key is stored. Null when the credential store could not be read, which is not evidence that no key is stored.",
    ),
  hasWebhookSecret: z.boolean(),
  clientInstallationId: z.string().nullable(),
  available: z.boolean(),
  organizationId: z.string().nullable(),
  userId: z.string().nullable(),
});
type CloudStatusResponse = z.infer<typeof CloudStatusResponseSchema>;

const CloudConnectResponseSchema = z.object({
  alreadyConnected: z.boolean().optional(),
  baseUrl: z.string().optional(),
  showCloudLogin: z.boolean().optional(),
  /**
   * The stored cloud credential exists but the cloud rejects it. Distinct
   * from "nothing stored": the user is not setting up, they are recovering,
   * and what replaces the key is a fresh sign-in, not a first one.
   */
  credentialRejected: z.boolean().optional(),
});
export type CloudConnectResponse = z.infer<typeof CloudConnectResponseSchema>;

const CloudDisconnectResponseSchema = z.object({
  disconnected: z.literal(true),
  previousBaseUrl: z.string().nullable(),
});
type CloudDisconnectResponse = z.infer<typeof CloudDisconnectResponseSchema>;

const CallbackRouteRegisterRequestSchema = z.object({
  path: z.string(),
  type: z.string(),
});

const CallbackRouteRegisterResponseSchema = z.object({
  callbackUrl: z.string(),
  callbackPath: z.string(),
  type: z.string(),
});
type CallbackRouteRegisterResponse = z.infer<
  typeof CallbackRouteRegisterResponseSchema
>;

const CallbackRouteSchema = z.object({
  id: z.string(),
  assistant_id: z.string(),
  type: z.string(),
  callback_path: z.string(),
  callback_url: z.string(),
  source_identifier: z.string().nullable(),
});

const CallbackRoutesListResponseSchema = z.object({
  routes: z.array(CallbackRouteSchema),
});
type CallbackRoutesListResponse = z.infer<
  typeof CallbackRoutesListResponseSchema
>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCloudStatus(
  _args: RouteHandlerArgs,
): Promise<CloudStatusResponse> {
  const context = await resolveCloudCallbackRegistrationContext();

  const [organizationId, userId, webhookSecretRaw] = await Promise.all([
    resolveCloudOrganizationId(),
    resolveCloudUserId(),
    getSecureKeyAsync(credentialKey("cadet", "webhook_secret")),
  ]);

  const hasWebhookSecret = !!webhookSecretRaw;

  return {
    isCloud: context.isCloud,
    baseUrl: context.cloudBaseUrl,
    assistantId: context.assistantId,
    hasAssistantApiKey: context.hasAssistantApiKey,
    hasWebhookSecret,
    clientInstallationId: getExistingDeviceId(),
    available: context.enabled,
    organizationId: organizationId || null,
    userId: userId || null,
  };
}

async function handleCloudConnect(
  _args: RouteHandlerArgs,
): Promise<CloudConnectResponse> {
  // Check if already connected
  const existingApiKey = await getSecureKeyAsync(
    credentialKey(CREDENTIAL_KEYS.apiKey.service, CREDENTIAL_KEYS.apiKey.field),
  );

  // Stored credentials only count as a connection while they still
  // authenticate. Answering "already connected" for a key the cloud has
  // rejected would report nothing to do about the one thing that needs doing,
  // and no client would get the signal to rotate it.
  //
  // Checked here rather than read from a cache: connect is a deliberate user
  // action, so one request is affordable, and an answer computed now cannot go
  // stale between the check and the answer. An unreachable cloud leaves the
  // stored credentials counting as a connection, so a network problem never
  // strands a working install by reporting it disconnected.
  let credentialRejected = false;
  if (existingApiKey) {
    const verified = await verifyStoredCredential();
    if (verified !== "rejected") {
      return {
        alreadyConnected: true,
        baseUrl: getCloudBaseUrl(),
      };
    }
    credentialRejected = true;
  }

  // The outcome travels in the response, where the CLI reads it and tells the
  // user what to do. Nothing shipped consumes the signal below, so the
  // response is the only path the answer reaches anyone by.
  broadcastMessage({ type: "show_cloud_login" });

  return credentialRejected
    ? { showCloudLogin: true, credentialRejected: true }
    : { showCloudLogin: true };
}

/**
 * Ask the cloud whether the stored cloud credential authenticates.
 * Nothing is stored: each caller that needs the answer asks, so there is no
 * verdict to go stale.
 *
 * Shared by the verification route and by connect, so the two cannot disagree
 * about what "connected" means. Never throws: an unsettled answer is
 * `"unknown"`, which no caller treats as evidence of a dead credential.
 */
async function verifyStoredCredential(): Promise<CloudCredentialVerificationStatus> {
  try {
    const { checkAssistantApiKey } =
      await import("../../credential-health/credential-health-service.js");
    const result = await checkAssistantApiKey();
    if (result === null) {
      // No cloud identity at all, so there is nothing to verify.
      return "unknown";
    }
    if (result.status === "healthy") {
      return "valid";
    }
    if (result.status === "revoked" || result.status === "missing_token") {
      return "rejected";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function handleCloudVerifyCredential(
  _args: RouteHandlerArgs,
): Promise<CloudVerifyCredentialResponse> {
  return { status: await verifyStoredCredential() };
}

async function handleCloudDisconnect(
  _args: RouteHandlerArgs,
): Promise<CloudDisconnectResponse> {
  // Reject if running inside a cloud host
  if (getIsCloud()) {
    throw new UnprocessableEntityError(
      "Cannot disconnect from the cloud on a cloud-hosted assistant.",
    );
  }

  // Check if connected
  const apiKey = await getSecureKeyAsync(
    credentialKey(CREDENTIAL_KEYS.apiKey.service, CREDENTIAL_KEYS.apiKey.field),
  );

  if (!apiKey) {
    throw new UnprocessableEntityError(
      "Not connected to a cloud. Nothing to disconnect.\n\n" +
        "Run 'assistant cloud status' to check connection state.",
    );
  }

  // Delete the stored cloud credential. The cloud_*_id fields are not
  // credentials — they resolve from the api key via validate and live only
  // in the in-memory identity, cleared right below.
  const keysToDelete = [CREDENTIAL_KEYS.apiKey] as const;

  const failedKeys: string[] = [];
  for (const key of keysToDelete) {
    const result = await deleteSecureKeyAsync(
      credentialKey(key.service, key.field),
    );
    if (result === "error") {
      failedKeys.push(`${key.service}:${key.field}`);
    }
  }

  if (failedKeys.length > 0) {
    throw new InternalError(
      `Failed to delete credentials: ${failedKeys.join("; ")}`,
    );
  }

  setCloudAssistantId(undefined);
  setCloudOrganizationId(undefined);
  setCloudUserId(undefined);

  // Notify connected clients
  broadcastMessage({ type: "cloud_disconnected" });

  return {
    disconnected: true,
    previousBaseUrl: null,
  };
}

async function handleCallbackRoutesRegister(
  args: RouteHandlerArgs,
): Promise<CallbackRouteRegisterResponse> {
  const { path, type } = (args.body ?? {}) as {
    path?: string;
    type?: string;
  };

  if (!path || typeof path !== "string") {
    throw new BadRequestError("path is required");
  }
  if (!type || typeof type !== "string") {
    throw new BadRequestError("type is required");
  }

  const context = await resolveCloudCallbackRegistrationContext();
  if (!context.enabled) {
    throw new UnprocessableEntityError(
      "Cloud callbacks not available — missing cloud base URL, assistant ID, or API key. Run 'assistant cloud connect' or ensure credentials are configured.",
    );
  }

  let callbackUrl: string;
  try {
    callbackUrl = await registerCallbackRoute(path, type);
  } catch (err) {
    throw new InternalError(
      `Failed to register callback route: ${(err as Error).message}`,
    );
  }

  return {
    callbackUrl,
    callbackPath: path,
    type,
  };
}

async function handleCallbackRoutesList(
  _args: RouteHandlerArgs,
): Promise<CallbackRoutesListResponse> {
  const routes = (await fetchCloudJson(
    "/v1/internal/gateway/callback-routes/",
    "callback routes",
  )) as Array<{
    id: string;
    assistant_id: string;
    type: string;
    callback_path: string;
    callback_url: string;
    source_identifier: string | null;
  }>;

  return { routes };
}

/** Default per-request timeout for cloud fetches. */
const CLOUD_FETCH_TIMEOUT_MS = 10_000;

/**
 * GET a JSON resource from the cloud using the assistant's stored cloud
 * credentials. Throws UnprocessableEntityError when credentials are missing and
 * InternalError on transport / non-2xx failures; `label` names the resource in
 * those error messages.
 */
async function fetchCloudJson(path: string, label: string): Promise<unknown> {
  const context = await resolveCloudCallbackRegistrationContext();

  if (!context.cloudBaseUrl || !context.authHeader) {
    throw new UnprocessableEntityError(
      "Cloud credentials not available — run 'assistant cloud connect' or set CADET_CLOUD_URL",
    );
  }

  const url = `${context.cloudBaseUrl}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: context.authHeader,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new InternalError(
      `Failed to fetch ${label}: ${(err as Error).message}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new InternalError(
      `Failed to fetch ${label} (HTTP ${response.status}): ${detail}`,
    );
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "cloud_status",
    endpoint: "cloud/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get cloud deployment context and connection status",
    description:
      "Aggregates cloud context, credentials, assistant ID, and webhook secret. Tunnel status is reported separately by gateway_status.",
    tags: ["cloud"],
    handler: handleCloudStatus,
    responseBody: CloudStatusResponseSchema,
  },
  {
    operationId: "cloud_connect",
    endpoint: "cloud/connect",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Connect to Cadet Cloud",
    description:
      "Checks whether the stored cloud credentials still connect. Reports a stored key Cadet Cloud rejects as credentialRejected, so the caller can direct the user to sign in again and replace it.",
    tags: ["cloud"],
    handler: handleCloudConnect,
    responseBody: CloudConnectResponseSchema,
  },
  {
    operationId: "cloud_verify_credential",
    endpoint: "cloud/verify-credential",
    method: "POST",
    // The in-app repair calls this through the gateway with an actor token,
    // the same caller shape as cloud_status, so it takes that route's
    // principal bundle. A local-only policy would 403 every browser repair
    // after it had already rotated and stored the replacement. Read scope:
    // the route performs a check and mutates nothing.
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Verify the Cadet Cloud credential against the cloud",
    description:
      "Asks the cloud whether the stored assistant API key authenticates. POST because it performs a check; the result is returned, not stored.",
    tags: ["cloud"],
    handler: handleCloudVerifyCredential,
    responseBody: CloudVerifyCredentialResponseSchema,
  },
  {
    operationId: "cloud_disconnect",
    endpoint: "cloud/disconnect",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Disconnect from Cadet Cloud",
    description:
      "Deletes stored cloud credentials and emits cloud_disconnected signal to connected clients.",
    tags: ["cloud"],
    handler: handleCloudDisconnect,
    responseBody: CloudDisconnectResponseSchema,
  },
  {
    operationId: "cloud_callback_routes_register",
    endpoint: "cloud/callback-routes/register",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Register a cloud callback route",
    description:
      "Registers a callback route with the cloud gateway for inbound provider webhooks.",
    tags: ["cloud"],
    handler: handleCallbackRoutesRegister,
    requestBody: CallbackRouteRegisterRequestSchema,
    responseBody: CallbackRouteRegisterResponseSchema,
  },
  {
    operationId: "cloud_callback_routes_list",
    endpoint: "cloud/callback-routes",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "List registered cloud callback routes",
    description:
      "Lists all callback routes registered with the cloud for this assistant.",
    tags: ["cloud"],
    handler: handleCallbackRoutesList,
    responseBody: CallbackRoutesListResponseSchema,
  },
];
