import { describe, expect, mock, test } from "bun:test";

import { z } from "zod";

import type { orchestrateOAuthConnect } from "../oauth/connect-orchestrator.js";
import { jsonObjectSchema } from "./helpers/json-object-schema.js";

const mockGetApp = mock((_appId: string) => ({
  id: "app-1",
  provider: "google",
  clientId: "client-1",
}));

const mockListConnections = mock(() => [
  {
    id: "conn-1",
    provider: "google",
    accountInfo: '{"email":"alice@example.com"}',
    grantedScopes: '["email","profile"]',
    status: "active",
    hasRefreshToken: 1,
    expiresAt: 1735689600000,
    createdAt: 1735689500000,
    updatedAt: 1735689550000,
  },
  {
    id: "conn-2",
    provider: "google",
    accountInfo: null,
    grantedScopes: [],
    status: "active",
    hasRefreshToken: 0,
    expiresAt: null,
    createdAt: 1735689601000,
    updatedAt: 1735689602000,
  },
]);

mock.module("../oauth/oauth-store.js", () => ({
  deleteApp: mock(() => Promise.resolve()),
  disconnectOAuthProvider: mock(() => Promise.resolve()),
  getApp: mockGetApp,
  getAppClientSecret: mock(() => Promise.resolve(undefined)),
  getConnection: mock(() => undefined),
  getProvider: mock((provider: string) =>
    provider === "google"
      ? {
          provider: "google",
          displayLabel: "Google",
          description: "Google OAuth provider",
          dashboardUrl: "https://console.cloud.google.com/apis/credentials",
          logoUrl: null,
          clientIdPlaceholder: null,
          requiresClientSecret: 1,
          cloudServiceConfigKey: "google-oauth",
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenExchangeUrl: "https://oauth2.googleapis.com/token",
          refreshUrl: null,
          tokenEndpointAuthMethod: "client_secret_post",
          tokenExchangeBodyFormat: "form",
          userinfoUrl: null,
          baseUrl: null,
          defaultScopes: "[]",
          availableScopes: null,
          scopeSeparator: null,
          authorizeParams: null,
          pingUrl: null,
          pingMethod: null,
          pingHeaders: null,
          pingBody: null,
          revokeUrl: null,
          revokeBodyTemplate: null,
          loopbackPort: null,
          injectionTemplates: null,
          appType: null,
          setupNotes: null,
          identityUrl: null,
          identityMethod: null,
          identityHeaders: null,
          identityBody: null,
          identityFormat: null,
          identityOkField: null,
          responseOkField: null,
          featureFlag: null,
          createdAt: 1735689500000,
          updatedAt: 1735689550000,
        }
      : undefined,
  ),
  listApps: mock(() => []),
  listConnections: mockListConnections,
  upsertApp: mock(() =>
    Promise.resolve({
      id: "app-1",
      provider: "google",
      clientId: "client-1",
      createdAt: 1735689500000,
      updatedAt: 1735689550000,
    }),
  ),
}));

const mockOrchestrateOAuthConnect = mock<typeof orchestrateOAuthConnect>(() =>
  Promise.resolve({
    success: true,
    deferred: false,
    grantedScopes: [],
    accountInfo: undefined,
    refreshTokenPresent: false,
  }),
);

mock.module("../oauth/connect-orchestrator.js", () => ({
  orchestrateOAuthConnect: mockOrchestrateOAuthConnect,
}));

import { BadRequestError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/oauth-apps.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";

function getRoute(method: string, endpoint: string) {
  const route = ROUTES.find(
    (r) => r.method === method && r.endpoint === endpoint,
  );
  if (!route) {
    throw new Error(`Route not found: ${method} ${endpoint}`);
  }
  return route;
}

function makeArgs(
  opts: {
    pathParams?: Record<string, string>;
    queryParams?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {},
): RouteHandlerArgs {
  return {
    pathParams: opts.pathParams,
    queryParams: opts.queryParams,
    body: opts.body,
  };
}

describe("GET /v1/oauth/apps/:appId/connections", () => {
  test("normalizes granted_scopes and has_refresh_token", async () => {
    const result = jsonObjectSchema.parse(
      await getRoute("GET", "oauth/apps/:appId/connections").handler(
        makeArgs({ pathParams: { appId: "app-1" } }),
      ),
    );

    const connections = z.array(jsonObjectSchema).parse(result.connections);
    expect(connections[0]?.granted_scopes).toEqual(["email", "profile"]);
    expect(connections[0]?.has_refresh_token).toBe(true);
    expect(connections[1]?.granted_scopes).toEqual([]);
    expect(connections[1]?.has_refresh_token).toBe(false);
  });
});

describe("GET /v1/oauth/apps", () => {
  test("returns provider metadata with correct types when provider exists", async () => {
    const result = jsonObjectSchema.parse(
      await getRoute("GET", "oauth/apps").handler(
        makeArgs({ queryParams: { provider_key: "google" } }),
      ),
    );

    const provider = jsonObjectSchema.parse(result.provider);
    expect(provider.provider_key).toBe("google");
    expect(provider.display_name).toBe("Google");
    expect(provider.description).toBe("Google OAuth provider");
    expect(provider.requires_client_secret).toBe(true);
    expect(typeof provider.requires_client_secret).toBe("boolean");
  });

  test("returns null provider when provider does not exist", async () => {
    const result = jsonObjectSchema.parse(
      await getRoute("GET", "oauth/apps").handler(
        makeArgs({ queryParams: { provider_key: "unknown" } }),
      ),
    );

    expect(result.provider).toBeNull();
  });
});

describe("POST /v1/oauth/apps/:appId/connect — callback_transport", () => {
  test('callback_transport: "gateway" is accepted and passed through', async () => {
    mockOrchestrateOAuthConnect.mockClear();
    await getRoute("POST", "oauth/apps/:appId/connect").handler(
      makeArgs({
        pathParams: { appId: "app-1" },
        body: { callback_transport: "gateway" },
      }),
    );

    expect(mockOrchestrateOAuthConnect).toHaveBeenCalledTimes(1);
    const callArgs = mockOrchestrateOAuthConnect.mock.calls[0]![0];
    expect(callArgs.callbackTransport).toBe("gateway");
  });

  test('callback_transport: "loopback" is accepted and passed through', async () => {
    mockOrchestrateOAuthConnect.mockClear();
    await getRoute("POST", "oauth/apps/:appId/connect").handler(
      makeArgs({
        pathParams: { appId: "app-1" },
        body: { callback_transport: "loopback" },
      }),
    );

    expect(mockOrchestrateOAuthConnect).toHaveBeenCalledTimes(1);
    const callArgs = mockOrchestrateOAuthConnect.mock.calls[0]![0];
    expect(callArgs.callbackTransport).toBe("loopback");
  });

  test('omitting callback_transport defaults to "loopback"', async () => {
    mockOrchestrateOAuthConnect.mockClear();
    await getRoute("POST", "oauth/apps/:appId/connect").handler(
      makeArgs({
        pathParams: { appId: "app-1" },
        body: { scopes: ["email"] },
      }),
    );

    expect(mockOrchestrateOAuthConnect).toHaveBeenCalledTimes(1);
    const callArgs = mockOrchestrateOAuthConnect.mock.calls[0]![0];
    expect(callArgs.callbackTransport).toBe("loopback");
  });

  test('invalid callback_transport "websocket" throws BadRequestError', async () => {
    mockOrchestrateOAuthConnect.mockClear();
    expect(() =>
      getRoute("POST", "oauth/apps/:appId/connect").handler(
        makeArgs({
          pathParams: { appId: "app-1" },
          body: { callback_transport: "websocket" },
        }),
      ),
    ).toThrow(BadRequestError);
    expect(mockOrchestrateOAuthConnect).not.toHaveBeenCalled();
  });

  test("invalid callback_transport (number) throws BadRequestError", async () => {
    mockOrchestrateOAuthConnect.mockClear();
    expect(() =>
      getRoute("POST", "oauth/apps/:appId/connect").handler(
        makeArgs({
          pathParams: { appId: "app-1" },
          body: { callback_transport: 123 },
        }),
      ),
    ).toThrow(BadRequestError);
    expect(mockOrchestrateOAuthConnect).not.toHaveBeenCalled();
  });
});
