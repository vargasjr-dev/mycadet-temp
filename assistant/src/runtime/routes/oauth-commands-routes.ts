/**
 * Route handlers for OAuth CLI command operations: disconnect, status, ping,
 * token, and request.
 *
 * These routes back the thin IPC wrappers in assistant/src/cli/commands/oauth/.
 */

import { readFileSync } from "node:fs";

import { channelForBotProvider } from "@mycadet/service-contracts/channels";

import type {
  OAuthConnectionRequest,
  OAuthConnectionResponse,
} from "../../oauth/connection.js";
import {
  isBinaryOAuthBody,
  jsonSafeOAuthBody,
} from "../../oauth/connection.js";
import {
  resolveOAuthConnection,
  type ResolveOAuthConnectionOptions,
  resolveOAuthConnectionWithMeta,
} from "../../oauth/connection-resolver.js";
import { providerReportsFailure } from "../../oauth/identity-verifier.js";
import { syncManualTokenConnection } from "../../oauth/manual-token-connection.js";
import {
  disconnectOAuthProvider,
  getActiveConnection,
  getAppByProviderAndClientId,
  getConnection,
  getProvider,
  listActiveConnectionsByProvider,
  listConnections,
  type OAuthProviderRow,
} from "../../oauth/oauth-store.js";
import { missingScopesForStoredToken } from "../../oauth/scope-utils.js";
import { withValidToken } from "../../security/token-manager.js";
import { matchHostPattern } from "../../tools/credentials/host-pattern-match.js";
import { parseJsonSafe } from "../../util/json.js";
import {
  findContentTypeHeader,
  parseRequestBodyBytes,
  parseRequestBodyData,
} from "../../util/oauth-request-body.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import { composeRequestHint } from "./oauth-request-hints.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseUrl(value: string | null | undefined): URL | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function getAllowedRequestHostPatterns(
  providerRow: OAuthProviderRow,
): string[] {
  const patterns: string[] = [];

  if (providerRow.injectionTemplates) {
    try {
      const parsed = JSON.parse(providerRow.injectionTemplates) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (
            entry &&
            typeof entry === "object" &&
            typeof (entry as { hostPattern?: unknown }).hostPattern === "string"
          ) {
            const hostPattern = (
              entry as { hostPattern: string }
            ).hostPattern.trim();
            if (hostPattern) {
              patterns.push(hostPattern);
            }
          }
        }
      }
    } catch {
      // Fall back to the provider's base URL host below.
    }
  }

  if (patterns.length === 0) {
    const baseUrl = parseUrl(providerRow.baseUrl);
    if (baseUrl) {
      patterns.push(baseUrl.hostname);
    }
  }

  return [...new Set(patterns)];
}

function assertOAuthRequestUrlAllowed(
  providerRow: OAuthProviderRow,
  parsedUrl: URL,
): void {
  const providerBaseUrl = parseUrl(providerRow.baseUrl);
  const allowedProtocol = providerBaseUrl?.protocol ?? "https:";
  if (parsedUrl.protocol !== allowedProtocol) {
    throw new BadRequestError(
      `OAuth request URL for "${providerRow.provider}" must use ${allowedProtocol.replace(/:$/, "")}.`,
    );
  }

  const allowedHostPatterns = getAllowedRequestHostPatterns(providerRow);
  if (allowedHostPatterns.length === 0) {
    throw new BadRequestError(
      `OAuth provider "${providerRow.provider}" does not define an allowed request host.`,
    );
  }

  const allowed = allowedHostPatterns.some(
    (pattern) =>
      matchHostPattern(parsedUrl.hostname, pattern, {
        includeApexForWildcard: true,
      }) !== "none",
  );
  if (!allowed) {
    throw new BadRequestError(
      `OAuth request URL host "${parsedUrl.hostname}" is not allowed for "${providerRow.provider}". Allowed hosts: ${allowedHostPatterns.join(", ")}.`,
    );
  }
}

/**
 * The verdict on a provider exchange: whether the status said success, and
 * whether the provider's declared ok field (`responseOkField`) then took it
 * back. The field is read only under a 2xx, so a 429 or 5xx whose body
 * happens to carry it stays a transport failure rather than a refusal.
 * `reportedFailure` is the one-line account of a refusal, absent otherwise.
 */
function judgeProviderResponse(
  providerRow: OAuthProviderRow,
  response: OAuthConnectionResponse,
): { ok: boolean; reportedFailure?: string } {
  const httpOk = response.status >= 200 && response.status < 300;
  if (httpOk && providerReportsFailure(providerRow, response.body)) {
    return {
      ok: false,
      reportedFailure: `${providerRow.provider} answered HTTP ${response.status} but reported ${providerRow.responseOkField}: false`,
    };
  }
  return { ok: httpOk };
}

/**
 * Required scopes the resolved connection's stored grant lacks. Credential
 * health measures the same thing on the heartbeat; measuring it on the
 * request names the gap at the moment a call may depend on it, since a
 * connection made before a scope was required keeps working for every call
 * that does not need it. A cloud connection has no local row and reports
 * nothing.
 */
function missingScopesForConnection(
  providerRow: OAuthProviderRow,
  connectionId: string,
): string[] {
  const row = getConnection(connectionId);
  if (!row) {
    return [];
  }
  return missingScopesForStoredToken(
    parseJsonSafe<string[]>(providerRow.defaultScopes ?? "[]") ?? [],
    parseJsonSafe<Record<string, string>>(providerRow.authorizeParams ?? "") ??
      undefined,
    providerRow.scopeSeparator,
    parseJsonSafe<string[]>(row.grantedScopes ?? "[]") ?? [],
  );
}

// ---------------------------------------------------------------------------
// Disconnect handler
// ---------------------------------------------------------------------------

async function handleDisconnect({ body = {} }: RouteHandlerArgs) {
  const b = body as {
    provider: string;
    account?: string;
    connection_id?: string;
  };

  if (!b.provider) {
    throw new BadRequestError("provider is required");
  }

  const providerRow = getProvider(b.provider);
  if (!providerRow) {
    throw new NotFoundError(
      `Unknown provider "${b.provider}". Run 'assistant oauth providers list' to see available providers.`,
    );
  }

  if (b.account && b.connection_id) {
    throw new BadRequestError(
      `Cannot specify both account and connection_id. Use one or the other.`,
    );
  }

  // BYO path
  let connectionId: string | undefined;
  let accountLabel: string | undefined;

  if (b.account) {
    const conn = getActiveConnection(b.provider, { account: b.account });
    if (!conn) {
      throw new NotFoundError(
        `No active connection found for "${b.provider}" with account "${b.account}".`,
      );
    }
    connectionId = conn.id;
    accountLabel = conn.accountInfo ?? undefined;
  } else if (b.connection_id) {
    const conn = getConnection(b.connection_id);
    if (!conn || conn.provider !== b.provider) {
      throw new NotFoundError(
        `Connection "${b.connection_id}" is not an active ${b.provider} connection.`,
      );
    }
    connectionId = conn.id;
    accountLabel = conn.accountInfo ?? undefined;
  } else {
    const active = listActiveConnectionsByProvider(b.provider);
    if (active.length === 0) {
      throw new NotFoundError(
        `No active connections found for "${b.provider}".`,
      );
    }
    if (active.length > 1) {
      throw new BadRequestError(
        `Multiple active connections for "${b.provider}". Specify which one to disconnect with account or connection_id. ` +
          `Run 'assistant oauth status ${b.provider}' to see connected accounts and IDs.`,
      );
    }
    connectionId = active[0].id;
    accountLabel = active[0].accountInfo ?? undefined;
  }

  const oauthResult = await disconnectOAuthProvider(
    b.provider,
    undefined,
    connectionId,
  );
  if (oauthResult === "error") {
    throw new InternalError(
      `Failed to disconnect OAuth provider "${b.provider}" — please try again.`,
    );
  }

  const result: Record<string, unknown> = {
    ok: true,
    provider: b.provider,
    connectionId,
  };
  if (accountLabel) {
    result.account = accountLabel;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Status handler
// ---------------------------------------------------------------------------

async function handleStatus({ queryParams = {} }: RouteHandlerArgs) {
  const provider = queryParams.provider;
  if (!provider) {
    throw new BadRequestError("provider query param is required");
  }

  const providerRow = getProvider(provider);
  if (!providerRow) {
    throw new NotFoundError(
      `Unknown provider "${provider}". Run 'assistant oauth providers list' to see available providers.`,
    );
  }

  // BYO path
  if (providerRow.authorizeUrl === "urn:manual-token") {
    await syncManualTokenConnection(provider);
  }

  const allConnections = listConnections(provider);
  const activeRows = allConnections.filter((r) => r.status === "active");

  const connections = activeRows.map((r) => {
    let grantedScopes: string[] = [];
    try {
      grantedScopes = r.grantedScopes ? JSON.parse(r.grantedScopes) : [];
    } catch {
      // Malformed JSON — default to empty
    }

    return {
      id: r.id,
      account: r.accountInfo ?? null,
      grantedScopes,
      expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
      hasRefreshToken: r.hasRefreshToken === 1,
      status: r.status,
    };
  });

  return {
    ok: true,
    provider,
    connections,
  };
}

// ---------------------------------------------------------------------------
// Ping handler
// ---------------------------------------------------------------------------

async function handlePing({ body = {} }: RouteHandlerArgs) {
  const b = body as {
    provider: string;
    account?: string;
    client_id?: string;
  };

  if (!b.provider) {
    throw new BadRequestError("provider is required");
  }

  const providerRow = getProvider(b.provider);
  if (!providerRow) {
    throw new NotFoundError(
      `Unknown provider "${b.provider}". Run 'assistant oauth providers list' to see available providers.`,
    );
  }

  if (!providerRow.pingUrl) {
    throw new BadRequestError(
      `No ping URL configured for "${b.provider}". Register one with 'assistant oauth providers register --ping-url <url>'.`,
    );
  }

  const pingUrl = providerRow.pingUrl as string;
  const parsed = new URL(pingUrl);
  const baseUrl = `${parsed.protocol}//${parsed.host}`;
  const path = parsed.pathname;

  const query: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams) {
    query[key] = value;
  }

  const resolveOptions: ResolveOAuthConnectionOptions = {};
  if (b.account) {
    resolveOptions.account = b.account;
  }
  if (b.client_id) {
    resolveOptions.clientId = b.client_id;
  }

  const connection = await resolveOAuthConnection(b.provider, resolveOptions);

  const method = (providerRow.pingMethod as string | null) ?? "GET";

  const pingHeaders: Record<string, string> = providerRow.pingHeaders
    ? JSON.parse(providerRow.pingHeaders as string)
    : {};

  const pingBody: unknown = providerRow.pingBody
    ? JSON.parse(providerRow.pingBody as string)
    : undefined;

  const response = await connection.request({
    method,
    path,
    baseUrl,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(Object.keys(pingHeaders).length > 0 ? { headers: pingHeaders } : {}),
    ...(pingBody !== undefined ? { body: pingBody } : {}),
  });

  const verdict = judgeProviderResponse(providerRow, response);
  if (verdict.ok) {
    return { ok: true, provider: b.provider, status: response.status };
  }

  const payload: Record<string, unknown> = {
    ok: false,
    provider: b.provider,
    status: response.status,
    error: verdict.reportedFailure
      ? `Ping failed: ${verdict.reportedFailure}`
      : `Ping failed with HTTP ${response.status}`,
  };
  if (verdict.reportedFailure) {
    payload.body = response.body;
  }

  // A provider that refuses the ping inside a 2xx is refusing the credential
  // the same way a 401 does.
  if (
    response.status === 401 ||
    response.status === 403 ||
    verdict.reportedFailure
  ) {
    payload.hint =
      `Run 'assistant oauth status ${b.provider}' to check connection health. ` +
      `To reconnect, run 'assistant oauth connect --help'.`;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Token handler
// ---------------------------------------------------------------------------

async function handleToken({ body = {} }: RouteHandlerArgs) {
  const b = body as {
    provider: string;
    account?: string;
    client_id?: string;
  };

  if (!b.provider) {
    throw new BadRequestError("provider is required");
  }

  let tokenOpts: string | { connectionId: string } | undefined;

  if (b.account || b.client_id) {
    const conn = getActiveConnection(b.provider, {
      clientId: b.client_id,
      account: b.account,
    });
    if (!conn) {
      const hint = b.account
        ? ` for account "${b.account}"`
        : b.client_id
          ? ` with client ID "${b.client_id}"`
          : "";
      throw new NotFoundError(
        `No active connection found for "${b.provider}"${hint}. Connect first with 'assistant oauth connect ${b.provider}'.`,
      );
    }
    tokenOpts = { connectionId: conn.id };
  }

  const token = await withValidToken(b.provider, async (t) => t, tokenOpts);

  return { ok: true, token };
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

/**
 * Resolve a raw `data` string into a request body. A non-JSON Content-Type
 * keeps the payload as the caller's exact string so multipart and other
 * byte-sensitive payloads survive. Files are read as raw bytes: valid UTF-8
 * stays text, and anything else stays a Buffer.
 */
function readBodyData(data: string, contentType: string | undefined): unknown {
  if (data === "@-") {
    // This handler runs inside the daemon, whose stdin is a supervisor pipe
    // or /dev/null — never the caller's terminal. Stdin-based body input is
    // resolved CLI-side and arrives pre-parsed via `parsed_data`.
    throw new BadRequestError(
      'Stdin body input ("@-") is not supported on this endpoint. ' +
        "Pass the body inline, reference a file with @<path>, or use the assistant CLI.",
    );
  }

  if (data.startsWith("@")) {
    const filePath = data.slice(1);
    return parseRequestBodyBytes(readFileSync(filePath), contentType);
  }

  return parseRequestBodyData(data, contentType);
}

export async function handleRequest({ body = {} }: RouteHandlerArgs) {
  const b = body as {
    provider: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    /** Pre-parsed body data (file/stdin reading happens CLI-side). */
    parsed_data?: unknown;
    /** Raw data string (for direct API callers, not the CLI). */
    data?: string;
    /** When set to base64, `parsed_data` / `data` is a base64 string of raw bytes. */
    body_encoding?: "base64";
    force_get?: boolean;
    head?: boolean;
    account?: string;
    client_id?: string;
  };

  if (!b.provider) {
    throw new BadRequestError("provider is required");
  }
  if (!b.url) {
    throw new BadRequestError("url is required");
  }

  const providerRow = getProvider(b.provider);
  if (!providerRow) {
    throw new NotFoundError(
      `Unknown provider "${b.provider}". Run 'assistant oauth providers list' to see available providers.`,
    );
  }

  if (b.client_id) {
    const app = getAppByProviderAndClientId(b.provider, b.client_id);
    if (!app) {
      throw new NotFoundError(
        `No registered OAuth app found for "${b.provider}" with client ID "${b.client_id}".`,
      );
    }
  }

  // Parse URL
  let baseUrl: string | undefined;
  let requestPath: string;
  const queryFromUrl: Record<string, string | string[]> = {};

  if (b.url.startsWith("http://") || b.url.startsWith("https://")) {
    const parsed = new URL(b.url);
    assertOAuthRequestUrlAllowed(providerRow, parsed);
    baseUrl = `${parsed.protocol}//${parsed.host}`;
    requestPath = parsed.pathname;
    for (const [key, value] of parsed.searchParams.entries()) {
      const existing = queryFromUrl[key];
      if (existing !== undefined) {
        queryFromUrl[key] = Array.isArray(existing)
          ? [...existing, value]
          : [existing, value];
      } else {
        queryFromUrl[key] = value;
      }
    }
  } else {
    const qIdx = b.url.indexOf("?");
    if (qIdx !== -1) {
      requestPath = b.url.slice(0, qIdx);
      const embeddedParams = new URLSearchParams(b.url.slice(qIdx + 1));
      for (const [key, value] of embeddedParams.entries()) {
        const existing = queryFromUrl[key];
        if (existing !== undefined) {
          queryFromUrl[key] = Array.isArray(existing)
            ? [...existing, value]
            : [existing, value];
        } else {
          queryFromUrl[key] = value;
        }
      }
    } else {
      requestPath = b.url;
    }
  }

  // Resolve method
  let method: string;
  if (b.head) {
    method = "HEAD";
  } else if (b.method) {
    method = b.method.toUpperCase();
  } else if (b.force_get) {
    method = "GET";
  } else if (b.data !== undefined || b.parsed_data !== undefined) {
    method = "POST";
  } else {
    method = "GET";
  }

  // Handle body / query params
  let reqBody: unknown = undefined;
  const query: Record<string, string | string[]> = { ...queryFromUrl };

  // Use pre-parsed data from CLI, or fall back to raw data string for direct
  // API callers. A string here (a multipart or form-encoded payload) stays a
  // string all the way to the provider; only objects are serialized as JSON.
  const resolvedData =
    b.parsed_data !== undefined
      ? b.parsed_data
      : b.data !== undefined
        ? readBodyData(b.data, findContentTypeHeader(b.headers))
        : undefined;

  if (resolvedData !== undefined) {
    let rawBody = resolvedData;
    if (b.body_encoding === "base64") {
      if (typeof rawBody !== "string") {
        throw new BadRequestError(
          "body_encoding=base64 requires a string body",
        );
      }
      rawBody = Buffer.from(rawBody, "base64");
    }

    if (b.force_get) {
      if (typeof rawBody === "string") {
        const bodyParams = new URLSearchParams(rawBody);
        for (const [key, value] of bodyParams.entries()) {
          const existing = query[key];
          if (existing !== undefined) {
            query[key] = Array.isArray(existing)
              ? [...existing, value]
              : [existing, value];
          } else {
            query[key] = value;
          }
        }
      } else if (
        rawBody !== null &&
        typeof rawBody === "object" &&
        !Array.isArray(rawBody) &&
        !isBinaryOAuthBody(rawBody)
      ) {
        for (const [key, value] of Object.entries(
          rawBody as Record<string, unknown>,
        )) {
          const existing = query[key];
          const strValue = String(value);
          if (existing !== undefined) {
            query[key] = Array.isArray(existing)
              ? [...existing, strValue]
              : [existing, strValue];
          } else {
            query[key] = strValue;
          }
        }
      }
    } else {
      reqBody = rawBody;
    }
  }

  // Resolve connection and make request
  const resolveOptions: ResolveOAuthConnectionOptions = {};
  if (b.client_id) {
    resolveOptions.clientId = b.client_id;
  }
  if (b.account) {
    resolveOptions.account = b.account;
  }

  const { connection, ambiguous, allAccounts } =
    await resolveOAuthConnectionWithMeta(b.provider, resolveOptions);

  const headers = b.headers ?? {};

  const req: OAuthConnectionRequest = {
    method,
    path: requestPath,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(reqBody !== undefined ? { body: reqBody } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };

  const response = await connection.request(req);
  const encodedBody = jsonSafeOAuthBody(response.body);

  const verdict = judgeProviderResponse(providerRow, response);

  const result: Record<string, unknown> = {
    ok: verdict.ok,
    status: response.status,
    headers: response.headers,
    body: encodedBody.body,
    // Which connected account actually served the request, so the caller can
    // tell whether the intended account was used.
    account: connection.accountInfo,
  };
  if (encodedBody.bodyEncoding) {
    result.bodyEncoding = encodedBody.bodyEncoding;
  }

  // Surface a caller-visible warning when the provider had several active
  // connections and no account was pinned — the model must see that a
  // silent pick happened, not just the daemon log.
  if (ambiguous && allAccounts.length > 1) {
    const selected = allAccounts[0];
    result.accountWarning =
      `Multiple ${b.provider} accounts are connected (${allAccounts.join(", ")}); ` +
      `used "${selected}". Pass --account to select a specific one.`;
  }

  const hint = composeRequestHint({
    provider: b.provider,
    status: response.status,
    headers: response.headers,
    reportedFailure: verdict.reportedFailure,
    botChannel: channelForBotProvider(b.provider),
    resolvedBaseUrl: baseUrl ?? providerRow.baseUrl ?? undefined,
    missingScopes: missingScopesForConnection(providerRow, connection.id),
  });
  if (hint) {
    result.hint = hint;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "oauth_disconnect",
    endpoint: "oauth/disconnect",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Disconnect OAuth provider",
    description:
      "Disconnect an OAuth provider and remove associated credentials.",
    tags: ["oauth"],
    handler: handleDisconnect,
  },
  {
    operationId: "oauth_status",
    endpoint: "oauth/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Get OAuth status",
    description: "Show OAuth connection status for a specified provider.",
    tags: ["oauth"],
    queryParams: [
      {
        name: "provider",
        type: "string",
        required: true,
        description: "Provider key",
      },
    ],
    handler: handleStatus,
  },
  {
    operationId: "oauth_ping",
    endpoint: "oauth/ping",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Ping OAuth provider",
    description:
      "Verify an OAuth token is valid by hitting the provider's configured health-check endpoint.",
    tags: ["oauth"],
    handler: handlePing,
  },
  {
    operationId: "oauth_token",
    endpoint: "oauth/token",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Get OAuth token",
    description: "Retrieve a valid OAuth access token for a provider.",
    tags: ["oauth"],
    handler: handleToken,
  },
  {
    operationId: "oauth_request",
    endpoint: "oauth/request",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Make authenticated OAuth request",
    description:
      "Make an authenticated HTTP request through an OAuth connection (supports curl-like interface).",
    tags: ["oauth"],
    handler: handleRequest,
  },
];
