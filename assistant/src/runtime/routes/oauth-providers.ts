/**
 * Route handlers for OAuth provider CRUD.
 *
 * Provides endpoints for querying, registering, updating, and deleting OAuth
 * provider configurations. All endpoints are bearer-token authenticated via
 * the standard runtime auth middleware.
 */

import { INTEGRATION_CATEGORIES } from "@mycadet/service-contracts/integration-categories";
import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { getOAuthCallbackUrl } from "../../inbound/public-ingress-urls.js";
import {
  deleteApp,
  deleteConnection,
  deleteProvider,
  disconnectOAuthProvider,
  getProvider,
  listApps,
  listConnections,
  listProviders,
  registerProvider,
  updateProvider,
} from "../../oauth/oauth-store.js";
import {
  serializeProvider,
  serializeProviderSummary,
} from "../../oauth/provider-serializer.js";
import { SEEDED_PROVIDER_KEYS } from "../../oauth/seed-providers.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOOPBACK_CALLBACK_PATH = "/oauth/callback";

function resolveRedirectUri(loopbackPort: number | null): string | null {
  if (!loopbackPort) {
    return "http://localhost:<dynamic>/oauth/callback";
  }
  return `http://localhost:${loopbackPort}${LOOPBACK_CALLBACK_PATH}`;
}

function serializeProviderFull(row: ReturnType<typeof getProvider>) {
  if (!row) {
    return null;
  }
  return serializeProvider(row, {
    redirectUri: resolveRedirectUri(row.loopbackPort),
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleListProviders(_args: RouteHandlerArgs) {
  const rows = listProviders();
  const serialized = rows
    .map((row) => serializeProviderSummary(row))
    .filter((s): s is NonNullable<typeof s> => s !== null);

  return { providers: serialized };
}

function handleGetProvider({ pathParams = {} }: RouteHandlerArgs) {
  const { providerKey } = pathParams;
  const row = getProvider(providerKey);
  if (!row) {
    throw new NotFoundError(
      `No OAuth provider registered for "${providerKey}"`,
    );
  }

  let oauthCallbackUrl: string | null = null;
  try {
    oauthCallbackUrl = getOAuthCallbackUrl(getConfig());
  } catch {
    // Ingress not configured or disabled — callback URL unavailable
  }

  return {
    provider: serializeProviderFull(row),
    oauth_callback_url: oauthCallbackUrl,
  };
}

/** The registration body — validated at the boundary instead of cast field by field. */
const registerProviderBodySchema = z.object({
  provider_key: z.string(),
  auth_url: z.string(),
  token_url: z.string(),
  refresh_url: z.string().optional(),
  base_url: z.string().optional(),
  userinfo_url: z.string().optional(),
  default_scopes: z.array(z.string()).optional(),
  available_scopes: z
    .union([
      z.string(),
      z.array(
        z.object({
          scope: z.string(),
          description: z.string().optional(),
        }),
      ),
    ])
    .optional(),
  scope_separator: z.string().optional(),
  token_endpoint_auth_method: z.string().optional(),
  token_exchange_body_format: z.string().optional(),
  ping_url: z.string().optional(),
  ping_method: z.string().optional(),
  ping_headers: z.record(z.string(), z.string()).optional(),
  ping_body: z.unknown().optional(),
  revoke_url: z.string().optional(),
  revoke_body_template: z.record(z.string(), z.string()).optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  dashboard_url: z.string().optional(),
  logo_url: z.string().nullable().optional(),
  client_id_placeholder: z.string().optional(),
  requires_client_secret: z.boolean().optional(),
  loopback_port: z.number().optional(),
  injection_templates: z
    .array(
      z.object({
        hostPattern: z.string(),
        injectionType: z.string(),
        headerName: z.string(),
        valuePrefix: z.string(),
      }),
    )
    .optional(),
  app_type: z.string().optional(),
  identity_url: z.string().optional(),
  identity_method: z.string().optional(),
  identity_headers: z.record(z.string(), z.string()).optional(),
  identity_body: z.unknown().optional(),
  identity_response_paths: z.array(z.string()).optional(),
  identity_format: z.string().optional(),
  identity_ok_field: z.string().optional(),
  response_ok_field: z.string().optional(),
  setup_notes: z.array(z.string()).optional(),
});

function handleRegisterProvider({ body = {} }: RouteHandlerArgs) {
  const parsed = registerProviderBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      "provider_key, auth_url, and token_url are required",
    );
  }
  const b = parsed.data;
  const providerKey = b.provider_key;
  const authUrl = b.auth_url;
  const tokenUrl = b.token_url;

  try {
    const row = registerProvider({
      provider: providerKey,
      authorizeUrl: authUrl,
      tokenExchangeUrl: tokenUrl,
      refreshUrl: b.refresh_url ?? undefined,
      baseUrl: b.base_url ?? undefined,
      userinfoUrl: b.userinfo_url ?? undefined,
      defaultScopes: b.default_scopes ?? [],
      availableScopes: b.available_scopes ?? undefined,
      scopeSeparator: b.scope_separator ?? undefined,
      tokenEndpointAuthMethod: b.token_endpoint_auth_method ?? undefined,
      tokenExchangeBodyFormat: b.token_exchange_body_format ?? undefined,
      pingUrl: b.ping_url ?? undefined,
      pingMethod: b.ping_method ?? undefined,
      pingHeaders: b.ping_headers ?? undefined,
      pingBody: b.ping_body ?? undefined,
      revokeUrl: b.revoke_url ?? undefined,
      revokeBodyTemplate: b.revoke_body_template ?? undefined,
      displayLabel: b.display_name ?? undefined,
      description: b.description ?? undefined,
      dashboardUrl: b.dashboard_url ?? undefined,
      logoUrl: b.logo_url ?? undefined,
      clientIdPlaceholder: b.client_id_placeholder ?? undefined,
      requiresClientSecret:
        b.requires_client_secret === undefined
          ? undefined
          : b.requires_client_secret
            ? 1
            : 0,
      loopbackPort: b.loopback_port ?? undefined,
      injectionTemplates: b.injection_templates ?? undefined,
      appType: b.app_type ?? undefined,
      identityUrl: b.identity_url ?? undefined,
      identityMethod: b.identity_method ?? undefined,
      identityHeaders: b.identity_headers ?? undefined,
      identityBody: b.identity_body ?? undefined,
      identityResponsePaths: b.identity_response_paths ?? undefined,
      identityFormat: b.identity_format ?? undefined,
      identityOkField: b.identity_ok_field ?? undefined,
      responseOkField: b.response_ok_field ?? undefined,
      setupNotes: b.setup_notes ?? undefined,
    });

    return { provider: serializeProviderFull(row) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists")) {
      throw new ConflictError(msg);
    }
    throw new InternalError(msg);
  }
}

function handleUpdateProvider({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const { providerKey } = pathParams;
  const existing = getProvider(providerKey);
  if (!existing) {
    throw new NotFoundError(
      `No OAuth provider registered for "${providerKey}"`,
    );
  }

  if (SEEDED_PROVIDER_KEYS.has(providerKey)) {
    throw new BadRequestError(
      `Cannot update built-in provider "${providerKey}". Built-in providers are managed by the system.`,
    );
  }

  const b = body as Record<string, unknown>;
  const params: Record<string, unknown> = {};

  if (b.auth_url !== undefined) {
    params.authorizeUrl = b.auth_url;
  }
  if (b.token_url !== undefined) {
    params.tokenExchangeUrl = b.token_url;
  }
  if (b.refresh_url !== undefined) {
    params.refreshUrl = b.refresh_url;
  }
  if (b.base_url !== undefined) {
    params.baseUrl = b.base_url;
  }
  if (b.userinfo_url !== undefined) {
    params.userinfoUrl = b.userinfo_url;
  }
  if (b.default_scopes !== undefined) {
    params.defaultScopes = b.default_scopes;
  }
  if (b.available_scopes !== undefined) {
    params.availableScopes = b.available_scopes;
  }
  if (b.scope_separator !== undefined) {
    params.scopeSeparator = b.scope_separator;
  }
  if (b.token_endpoint_auth_method !== undefined) {
    params.tokenEndpointAuthMethod = b.token_endpoint_auth_method;
  }
  if (b.token_exchange_body_format !== undefined) {
    params.tokenExchangeBodyFormat = b.token_exchange_body_format;
  }
  if (b.ping_url !== undefined) {
    params.pingUrl = b.ping_url;
  }
  if (b.ping_method !== undefined) {
    params.pingMethod = b.ping_method;
  }
  if (b.ping_headers !== undefined) {
    params.pingHeaders = b.ping_headers;
  }
  if (b.ping_body !== undefined) {
    params.pingBody = b.ping_body;
  }
  if (b.revoke_url !== undefined) {
    params.revokeUrl = b.revoke_url;
  }
  if (b.revoke_body_template !== undefined) {
    params.revokeBodyTemplate = b.revoke_body_template;
  }
  if (b.display_name !== undefined) {
    params.displayLabel = b.display_name;
  }
  if (b.description !== undefined) {
    params.description = b.description;
  }
  if (b.dashboard_url !== undefined) {
    params.dashboardUrl = b.dashboard_url;
  }
  if (b.logo_url !== undefined) {
    params.logoUrl = b.logo_url;
  }
  if (b.client_id_placeholder !== undefined) {
    params.clientIdPlaceholder = b.client_id_placeholder;
  }
  if (b.requires_client_secret !== undefined) {
    params.requiresClientSecret = b.requires_client_secret;
  }
  if (b.loopback_port !== undefined) {
    params.loopbackPort = b.loopback_port;
  }
  if (b.injection_templates !== undefined) {
    params.injectionTemplates = b.injection_templates;
  }
  if (b.app_type !== undefined) {
    params.appType = b.app_type;
  }
  if (b.identity_url !== undefined) {
    params.identityUrl = b.identity_url;
  }
  if (b.identity_method !== undefined) {
    params.identityMethod = b.identity_method;
  }
  if (b.identity_headers !== undefined) {
    params.identityHeaders = b.identity_headers;
  }
  if (b.identity_body !== undefined) {
    params.identityBody = b.identity_body;
  }
  if (b.identity_response_paths !== undefined) {
    params.identityResponsePaths = b.identity_response_paths;
  }
  if (b.identity_format !== undefined) {
    params.identityFormat = b.identity_format;
  }
  if (b.identity_ok_field !== undefined) {
    params.identityOkField = b.identity_ok_field;
  }
  if (b.response_ok_field !== undefined) {
    params.responseOkField = b.response_ok_field;
  }
  if (b.setup_notes !== undefined) {
    params.setupNotes = b.setup_notes;
  }

  if (Object.keys(params).length === 0) {
    throw new BadRequestError("No fields to update");
  }

  const row = updateProvider(providerKey, params);
  return { provider: serializeProviderFull(row) };
}

async function handleDeleteProvider({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const { providerKey } = pathParams;
  const existing = getProvider(providerKey);
  if (!existing) {
    throw new NotFoundError(
      `No OAuth provider registered for "${providerKey}"`,
    );
  }

  const force = (body as Record<string, unknown>).force === true;

  const dependentApps = listApps().filter((a) => a.provider === providerKey);
  const dependentConnections = listConnections(providerKey);
  const appCount = dependentApps.length;
  const connCount = dependentConnections.length;

  if ((appCount > 0 || connCount > 0) && !force) {
    throw new BadRequestError(
      `Cannot delete provider "${providerKey}": ${appCount} app(s) and ${connCount} connection(s) depend on it. Set force=true to cascade-delete.`,
    );
  }

  // Cascade-delete connections first, then apps, then the provider
  for (const conn of dependentConnections) {
    const result = await disconnectOAuthProvider(
      providerKey,
      undefined,
      conn.id as string,
    );
    if (result === "error") {
      deleteConnection(conn.id);
    }
  }
  for (const app of dependentApps) {
    await deleteApp(app.id);
  }
  deleteProvider(providerKey);

  return {
    ok: true,
    deleted: { provider: 1, apps: appCount, connections: connCount },
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/**
 * Lightweight summary projection of an OAuth provider returned by the catalog
 * list endpoint. Mirrors `SerializedProviderSummary` from the provider
 * serializer (snake_case to match the HTTP API convention).
 */
export const oauthProviderSummarySchema = z.object({
  provider_key: z.string(),
  display_name: z.string().nullable(),
  description: z.string().nullable(),
  dashboard_url: z.string().nullable(),
  client_id_placeholder: z.string().nullable(),
  requires_client_secret: z.boolean(),
  logo_url: z.string().nullable(),
  category: z
    .enum(INTEGRATION_CATEGORIES)
    .nullable()
    .describe(
      "Where the integrations catalog files the provider; null for a provider without a seed entry.",
    ),
  tenant_host: z
    .object({
      pattern: z.string(),
      label: z.string(),
      placeholder: z.string(),
    })
    .nullable(),
  acts_as: z.enum(["user", "assistant"]),
});

/**
 * Response for the single-provider detail endpoint. The `provider` field is the
 * full serialized provider configuration — an open-ended, admin-defined object
 * whose keys depend on the stored row (parsed JSON blobs, identity templates,
 * and forwarded columns), so it is intentionally typed as an open record rather
 * than a closed schema. `oauth_callback_url` is the ingress callback URL the
 * web UI consumes (null when ingress is not configured).
 */
const oauthProviderDetailSchema = z.object({
  provider: z.record(z.string(), z.unknown()),
  oauth_callback_url: z.string().nullable(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "oauth_providers_get",
    endpoint: "oauth/providers",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List OAuth providers",
    description: "List all registered OAuth providers with optional filtering.",
    tags: ["oauth"],
    handler: handleListProviders,
    responseBody: z.object({
      providers: z.array(oauthProviderSummarySchema),
    }),
  },
  {
    operationId: "oauth_providers_by_providerKey_get",
    endpoint: "oauth/providers/:providerKey",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get OAuth provider",
    description: "Get a single OAuth provider by key.",
    tags: ["oauth"],
    handler: handleGetProvider,
    responseBody: oauthProviderDetailSchema,
  },
  {
    operationId: "oauth_providers_post",
    endpoint: "oauth/providers",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Register OAuth provider",
    description: "Register a new OAuth provider configuration.",
    tags: ["oauth"],
    responseStatus: "201",
    handler: handleRegisterProvider,
  },
  {
    operationId: "oauth_providers_by_providerKey_patch",
    endpoint: "oauth/providers/:providerKey",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update OAuth provider",
    description: "Update an existing custom OAuth provider configuration.",
    tags: ["oauth"],
    handler: handleUpdateProvider,
  },
  {
    operationId: "oauth_providers_by_providerKey_delete",
    endpoint: "oauth/providers/:providerKey",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete OAuth provider",
    description:
      "Delete a custom OAuth provider and optionally cascade-delete its apps and connections.",
    tags: ["oauth"],
    handler: handleDeleteProvider,
  },
];
