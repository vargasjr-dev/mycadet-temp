import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { useMemorySecureKeyMap } from "./helpers/secure-keys.js";

// The REAL secure-keys module pinned to an empty memory backend: no
// credentials configured, no keychain access.
useMemorySecureKeyMap();

import type { AssistantConfig } from "../config/schema.js";
import { listProviders, seedProviders } from "../oauth/oauth-store.js";
import { isProviderVisible } from "../oauth/provider-visibility.js";
import { initializeDb } from "../persistence/db-init.js";
import { resetTestTables } from "../persistence/raw-query.js";
import { resetDbForTesting } from "./db-test-helpers.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

await initializeDb();

/** Create a minimal AssistantConfig for testing. */
function makeConfig(): AssistantConfig {
  return {} as AssistantConfig;
}

beforeEach(() => {
  resetTestTables("oauth_connections", "oauth_apps", "oauth_providers");
  setOverridesForTesting({});
});

afterEach(() => {
  setOverridesForTesting({});
});

afterAll(() => {
  resetDbForTesting();
});

describe("isProviderVisible", () => {
  test("returns true when featureFlag is null", () => {
    seedProviders([
      {
        provider: "no-flag-provider",
        authorizeUrl: "https://example.com/auth",
        tokenExchangeUrl: "https://example.com/token",
        defaultScopes: ["read"],
      },
    ]);

    const providers = listProviders();
    const provider = providers.find((p) => p.provider === "no-flag-provider");
    expect(provider).toBeDefined();
    expect(provider!.featureFlag).toBeNull();

    const config = makeConfig();
    expect(isProviderVisible(provider!, config)).toBe(true);
  });

  test("returns true when featureFlag is set and the flag is enabled", () => {
    setOverridesForTesting({ "test-gate": true });

    seedProviders([
      {
        provider: "gated-provider",
        authorizeUrl: "https://example.com/auth",
        tokenExchangeUrl: "https://example.com/token",
        defaultScopes: ["read"],

        featureFlag: "test-gate",
      },
    ]);

    const providers = listProviders();
    const provider = providers.find((p) => p.provider === "gated-provider");
    expect(provider).toBeDefined();
    expect(provider!.featureFlag).toBe("test-gate");

    const config = makeConfig();
    expect(isProviderVisible(provider!, config)).toBe(true);
  });

  test("returns false when featureFlag is set and the flag is disabled", () => {
    setOverridesForTesting({ "test-gate": false });

    seedProviders([
      {
        provider: "gated-provider",
        authorizeUrl: "https://example.com/auth",
        tokenExchangeUrl: "https://example.com/token",
        defaultScopes: ["read"],

        featureFlag: "test-gate",
      },
    ]);

    const providers = listProviders();
    const provider = providers.find((p) => p.provider === "gated-provider");
    expect(provider).toBeDefined();

    const config = makeConfig();
    expect(isProviderVisible(provider!, config)).toBe(false);
  });

  test("listProviders returns all providers but isProviderVisible filters gated ones when flag is disabled", () => {
    setOverridesForTesting({ "test-gate": false });

    seedProviders([
      {
        provider: "visible-provider",
        authorizeUrl: "https://example.com/auth",
        tokenExchangeUrl: "https://example.com/token",
        defaultScopes: ["read"],
      },
      {
        provider: "gated-provider",
        authorizeUrl: "https://gated.example.com/auth",
        tokenExchangeUrl: "https://gated.example.com/token",
        defaultScopes: ["read"],

        featureFlag: "test-gate",
      },
    ]);

    const allProviders = listProviders();
    expect(allProviders).toHaveLength(2);

    const config = makeConfig();
    const visibleProviders = allProviders.filter((p) =>
      isProviderVisible(p, config),
    );
    expect(visibleProviders).toHaveLength(1);
    expect(visibleProviders[0]!.provider).toBe("visible-provider");
  });
});
