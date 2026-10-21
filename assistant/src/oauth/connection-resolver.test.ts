import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockProvider: Record<string, unknown> | undefined;
let mockConnection: Record<string, unknown> | undefined;
let mockConnections:
  | Array<Record<string, unknown> & { clientId?: string; accountInfo?: string }>
  | undefined;
let mockAccessToken: string | undefined;
let mockCloudClient: Record<string, unknown> | null = null;
let syncManualTokenCalls: string[] = [];

// ---------------------------------------------------------------------------
// Module mocks (must precede imports of the module under test)
// ---------------------------------------------------------------------------

mock.module("./oauth-store.js", () => ({
  getProvider: () => mockProvider,
  getActiveConnections: (
    _pk: string,
    opts?: { clientId?: string; account?: string },
  ) => {
    // Default to the single mockConnection unless a test sets an explicit list.
    const rows = mockConnections ?? (mockConnection ? [mockConnection] : []);
    return rows.filter((row) => {
      if (opts?.clientId && row.clientId !== opts.clientId) {
        return false;
      }
      if (opts?.account && row.accountInfo !== opts.account) {
        return false;
      }
      return true;
    });
  },
}));

import { useMemorySecureKeyMap } from "../__tests__/helpers/secure-keys.js";

// Pin an empty memory backend so transitive secure-key reads never touch the
// keychain; the connection token itself arrives via the resolver mock above.
useMemorySecureKeyMap();

mock.module("./credential-token-resolver.js", () => ({
  getConnectionAccessTokenResult: async () => ({
    value: mockAccessToken,
    unreachable: false,
    key: "mock-key",
  }),
}));

mock.module("./manual-token-connection.js", () => ({
  syncManualTokenConnection: async (provider: string) => {
    syncManualTokenCalls.push(provider);
    if (provider === "telegram" && mockConnection?.provider === "telegram") {
      mockConnection.accountInfo = "@example_bot";
    }
  },
}));

mock.module("../cloud/client.js", () => ({
  CadetCloudClient: {
    create: async () => mockCloudClient,
  },
}));

// ---------------------------------------------------------------------------
// Import the module under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import {
  formatNoConnectionError,
  resolveEffectiveBaseUrl,
  resolveOAuthConnection,
  resolveOAuthConnectionWithMeta,
  resolveTokenHeader,
} from "./connection-resolver.js";
import { UserOAuthConnection } from "./user-oauth-connection.js";

/** Seed `services.<key>.mode` entries into the workspace config for real. */
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockClient() {
  return {
    baseUrl: "https://platform.example.com",
    assistantApiKey: "sk-test-key",
    cloudAssistantId: "asst-123",
    fetch: mock(async () => {
      return new Response(
        JSON.stringify({
          results: [{ id: "platform-conn-1", account_label: null }],
        }),
        { status: 200 },
      );
    }),
  };
}

function setupDefaults(): void {
  mockProvider = {
    provider: "google",
    baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  };
  mockConnection = {
    id: "conn-1",
    provider: "google",
    oauthAppId: "app-1",
    accountInfo: "user@example.com",
    grantedScopes: JSON.stringify(["scope-a", "scope-b"]),
    status: "active",
    clientId: "client-1",
  };
  mockAccessToken = "tok-valid";
  mockConnections = undefined;
  mockCloudClient = makeMockClient();
  syncManualTokenCalls = [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveOAuthConnection", () => {
  beforeEach(() => {
    setupDefaults();
  });

  test("returns UserOAuthConnection when provider has no cloudServiceConfigKey", async () => {
    const result = await resolveOAuthConnection("google");
    expect(result).toBeInstanceOf(UserOAuthConnection);
    expect(result.id).toBe("conn-1");
    expect(result.provider).toBe("google");
  });

  test("narrows by clientId when provided", async () => {
    const result = await resolveOAuthConnection("google", {
      clientId: "client-1",
    });
    expect(result).toBeInstanceOf(UserOAuthConnection);
    expect(result.id).toBe("conn-1");
  });

  test("returns no credential when clientId does not match", async () => {
    await expect(
      resolveOAuthConnection("google", {
        clientId: "wrong-client",
      }),
    ).rejects.toThrow(/No active OAuth connection found/);
  });

  test("reconciles manual-token providers before exact account lookup", async () => {
    mockProvider = {
      provider: "telegram",
      baseUrl: "https://api.telegram.org",
      authorizeUrl: "urn:manual-token",
    };
    mockConnection = {
      id: "conn-telegram",
      provider: "telegram",
      oauthAppId: "app-telegram",
      accountInfo: null,
      grantedScopes: JSON.stringify([]),
      status: "active",
      clientId: "manual-config",
    };
    mockAccessToken = "telegram-test-token";

    const result = await resolveOAuthConnection("telegram", {
      account: "@example_bot",
    });

    expect(syncManualTokenCalls).toEqual(["telegram"]);
    expect(mockConnection.accountInfo).toBe("@example_bot");
    expect(result).toBeInstanceOf(UserOAuthConnection);
    expect(result.id).toBe("conn-telegram");
  });
});

describe("resolveOAuthConnection scope-awareness", () => {
  const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
  const GMAIL_FULL_ACCESS_SCOPE = "https://mail.google.com/";
  const CALENDAR_ONLY = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.email",
  ];
  const FULL_BUNDLE = [GMAIL_SCOPE, ...CALENDAR_ONLY];

  beforeEach(() => {
    setupDefaults();
  });

  test("rejects when granted scopes are known and missing the requirement", async () => {
    mockConnection!.grantedScopes = JSON.stringify(CALENDAR_ONLY);

    await expect(
      resolveOAuthConnection("google", { requiredScopes: [GMAIL_SCOPE] }),
    ).rejects.toThrow(/missing required access/);
  });

  test("treats full Gmail access as covering Gmail read access", async () => {
    mockConnection!.grantedScopes = JSON.stringify([GMAIL_FULL_ACCESS_SCOPE]);

    const result = await resolveOAuthConnection("google", {
      requiredScopes: [GMAIL_SCOPE],
    });
    expect(result).toBeInstanceOf(UserOAuthConnection);
  });

  test("unknown granted scopes never block", async () => {
    mockConnection!.grantedScopes = JSON.stringify([]);

    const result = await resolveOAuthConnection("google", {
      requiredScopes: [GMAIL_SCOPE],
    });
    expect(result).toBeInstanceOf(UserOAuthConnection);
  });

  test("picks an older scope-satisfying connection over a newer narrow one", async () => {
    // Newest first (matching the store's ordering): a Calendar-only row, then
    // an older row that carries the Gmail scope. The narrow row must not win.
    mockConnections = [
      {
        id: "cal-only",
        provider: "google",
        accountInfo: "user@example.com",
        grantedScopes: JSON.stringify(CALENDAR_ONLY),
        status: "active",
      },
      {
        id: "full",
        provider: "google",
        accountInfo: "user@example.com",
        grantedScopes: JSON.stringify(FULL_BUNDLE),
        status: "active",
      },
    ];

    const result = await resolveOAuthConnection("google", {
      requiredScopes: [GMAIL_SCOPE],
    });
    expect(result).toBeInstanceOf(UserOAuthConnection);
    expect(result.id).toBe("full");
  });
});

describe("resolveOAuthConnectionWithMeta multi-account visibility", () => {
  beforeEach(() => {
    setupDefaults();
  });

  test("multiple connections + no account surfaces ambiguity and the selected label", async () => {
    mockConnections = [
      {
        id: "conn-personal",
        provider: "google",
        accountInfo: "user@example.com",
        grantedScopes: JSON.stringify([]),
        status: "active",
      },
      {
        id: "conn-work",
        provider: "google",
        accountInfo: "work@example.com",
        grantedScopes: JSON.stringify([]),
        status: "active",
      },
    ];

    const { connection, ambiguous, allAccounts } =
      await resolveOAuthConnectionWithMeta("google");

    expect(ambiguous).toBe(true);
    expect(allAccounts).toEqual(["user@example.com", "work@example.com"]);
    expect(connection).toBeInstanceOf(UserOAuthConnection);
    expect(connection.id).toBe("conn-personal");
    expect(connection.accountInfo).toBe("user@example.com");
  });

  test("account passed disambiguates and clears the warning", async () => {
    mockConnections = [
      {
        id: "conn-work",
        provider: "google",
        accountInfo: "work@example.com",
        grantedScopes: JSON.stringify([]),
        status: "active",
      },
    ];

    const { ambiguous, connection } = await resolveOAuthConnectionWithMeta(
      "google",
      { account: "work@example.com" },
    );

    expect(ambiguous).toBe(false);
    expect(connection.id).toBe("conn-work");
  });

  test("single connection is never ambiguous", async () => {
    const { ambiguous, allAccounts } =
      await resolveOAuthConnectionWithMeta("google");

    expect(ambiguous).toBe(false);
    expect(allAccounts).toEqual(["user@example.com"]);
  });
});

describe("no-match error lists available accounts", () => {
  beforeEach(() => {
    setupDefaults();
  });

  test("names the provider's active accounts when the requested account misses", async () => {
    mockConnections = [
      {
        id: "conn-personal",
        provider: "google",
        accountInfo: "user@example.com",
        grantedScopes: JSON.stringify([]),
        status: "active",
      },
      {
        id: "conn-work",
        provider: "google",
        accountInfo: "other@example.org",
        grantedScopes: JSON.stringify([]),
        status: "active",
      },
    ];

    let message = "";
    try {
      await resolveOAuthConnection("google", {
        account: "missing@example.com",
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('account "missing@example.com"');
    expect(message).toContain(
      "Active google connections: user@example.com, other@example.org",
    );
    expect(message).toContain("Check the account spelling.");
  });

  test("zero connections keeps the plain 'needs to be connected' shape", async () => {
    mockConnections = [];

    let message = "";
    try {
      await resolveOAuthConnection("google", {
        account: "missing@example.com",
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toContain("Active google connections:");
    expect(message).toContain(
      "The google service needs to be connected before it can be used.",
    );
  });
});

describe("formatNoConnectionError", () => {
  test("appends available account labels when the provider has active connections", () => {
    // The requested account is a one-letter misspelling of an active one.
    const message = formatNoConnectionError({
      provider: "outlook",
      account: "usr@example.com",
      availableLabels: ["user@example.com", "other@example.org"],
    });
    expect(message).toBe(
      'No active OAuth connection found for provider "outlook" with account ' +
        '"usr@example.com". Active outlook connections: user@example.com, ' +
        "other@example.org. Check the account spelling.",
    );
  });

  test("keeps the plain message shape when no active connections exist", () => {
    const message = formatNoConnectionError({
      provider: "outlook",
      account: "user@example.com",
      availableLabels: [],
    });
    expect(message).toBe(
      'No active OAuth connection found for provider "outlook" with account ' +
        '"user@example.com". The outlook service needs to be connected before ' +
        "it can be used.",
    );
  });

  test("includes both account and client ID qualifiers when present", () => {
    const message = formatNoConnectionError({
      provider: "outlook",
      account: "user@example.com",
      clientId: "client-1",
      availableLabels: [],
    });
    expect(message).toContain(
      'with account "user@example.com" and client ID "client-1"',
    );
  });
});

describe("resolveEffectiveBaseUrl", () => {
  const fallback = "https://login.salesforce.com";

  test("uses instance_url from JSON-string metadata for Salesforce", () => {
    const metadata = JSON.stringify({
      instance_url: "https://acme.my.salesforce.com",
      issued_at: "1714000000000",
    });
    expect(resolveEffectiveBaseUrl("salesforce", fallback, metadata)).toBe(
      "https://acme.my.salesforce.com",
    );
  });

  test("uses instance_url from already-parsed object metadata", () => {
    const metadata = { instance_url: "https://na162.salesforce.com" };
    expect(resolveEffectiveBaseUrl("salesforce", fallback, metadata)).toBe(
      "https://na162.salesforce.com",
    );
  });

  test("falls back to seed baseUrl when metadata is null", () => {
    expect(resolveEffectiveBaseUrl("salesforce", fallback, null)).toBe(
      fallback,
    );
  });

  test("falls back to seed baseUrl when instance_url is empty string", () => {
    const metadata = JSON.stringify({ instance_url: "" });
    expect(resolveEffectiveBaseUrl("salesforce", fallback, metadata)).toBe(
      fallback,
    );
  });

  test("falls back to seed baseUrl when metadata is unparseable JSON", () => {
    expect(
      resolveEffectiveBaseUrl("salesforce", fallback, "{ not valid json"),
    ).toBe(fallback);
  });

  test("falls back to seed baseUrl when instance_url is the wrong type", () => {
    const metadata = JSON.stringify({ instance_url: 12345 });
    expect(resolveEffectiveBaseUrl("salesforce", fallback, metadata)).toBe(
      fallback,
    );
  });

  test("ignores instance_url for non-Salesforce providers", () => {
    // A different provider whose token response happens to include an
    // instance_url-shaped field MUST NOT have its baseUrl rewritten.
    const metadata = JSON.stringify({
      instance_url: "https://attacker.example.com",
    });
    expect(
      resolveEffectiveBaseUrl(
        "google",
        "https://gmail.googleapis.com/gmail/v1/users/me",
        metadata,
      ),
    ).toBe("https://gmail.googleapis.com/gmail/v1/users/me");
  });
});

describe("resolveTokenHeader", () => {
  const shopify = JSON.stringify([
    {
      hostPattern: "*.myshopify.com",
      injectionType: "header",
      headerName: "X-Shopify-Access-Token",
      valuePrefix: "",
    },
  ]);

  test("returns null when the provider declares no templates", () => {
    expect(resolveTokenHeader(undefined, "https://api.example.com")).toBeNull();
    expect(resolveTokenHeader(null, "https://api.example.com")).toBeNull();
    expect(resolveTokenHeader("[]", "https://api.example.com")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(
      resolveTokenHeader("{not json", "https://api.example.com"),
    ).toBeNull();
  });

  test("ignores non-header injection templates", () => {
    const query = JSON.stringify([
      {
        hostPattern: "api.example.com",
        injectionType: "query",
        headerName: "",
      },
    ]);
    expect(resolveTokenHeader(query, "https://api.example.com")).toBeNull();
  });

  test("picks the template whose wildcard host pattern matches the base URL", () => {
    const templates = JSON.stringify([
      {
        hostPattern: "api.other.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
      ...JSON.parse(shopify),
    ]);
    expect(
      resolveTokenHeader(templates, "https://example-store.myshopify.com"),
    ).toEqual({ name: "X-Shopify-Access-Token", valuePrefix: "" });
  });

  test("falls back to the first header template when the host cannot be matched", () => {
    // A still-templated base URL is not a parseable URL.
    expect(resolveTokenHeader(shopify, "https://{tenant_host}")).toEqual({
      name: "X-Shopify-Access-Token",
      valuePrefix: "",
    });
  });

  test("preserves the Bot prefix for discord_channel", () => {
    const discord = JSON.stringify([
      {
        hostPattern: "discord.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bot ",
      },
    ]);
    expect(resolveTokenHeader(discord, "https://discord.com/api")).toEqual({
      name: "Authorization",
      valuePrefix: "Bot ",
    });
  });
});
