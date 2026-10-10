import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  reseedMemorySecureKeys,
  useMemorySecureKeys,
} from "../__tests__/helpers/secure-keys.js";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockManagedProxyCtx = {
  enabled: false,
  cloudBaseUrl: "",
  assistantApiKey: "",
};
let mockAssistantId = "";
const mockSecureKeys = useMemorySecureKeys();
// Re-pointable so the probe-deadline tests can hang context resolution.
let mockResolveManagedProxyContext: () => Promise<
  typeof mockManagedProxyCtx
> = async () => mockManagedProxyCtx;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

mock.module("../providers/platform-proxy/context.js", () => ({
  resolveManagedProxyContext: () => mockResolveManagedProxyContext(),
}));

const actualEnv = await import("../config/env.js");
mock.module("../config/env.js", () => ({
  ...actualEnv,
  getCloudAssistantId: () => mockAssistantId,
}));

mock.module("../security/credential-key.js", () => ({
  credentialKey: (namespace: string, key: string) => `${namespace}:${key}`,
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  _resetConfiguredProbeCacheForTests,
  CadetPlatformClient,
  isPlatformClientConfigured,
} from "./client.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CadetPlatformClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockManagedProxyCtx = {
      enabled: true,
      cloudBaseUrl: "https://platform.example.com",
      assistantApiKey: "sk-test-key",
    };
    mockAssistantId = "asst-123";
    reseedMemorySecureKeys(mockSecureKeys);
    mockResolveManagedProxyContext = async () => mockManagedProxyCtx;
    _resetConfiguredProbeCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("create()", () => {
    test("returns a client when all prerequisites are met", async () => {
      const client = await CadetPlatformClient.create();
      expect(client).not.toBeNull();
      expect(client!.baseUrl).toBe("https://platform.example.com");
      expect(client!.assistantApiKey).toBe("sk-test-key");
      expect(client!.platformAssistantId).toBe("asst-123");
    });

    test("returns null when managed proxy is not enabled", async () => {
      mockManagedProxyCtx = {
        enabled: false,
        cloudBaseUrl: "",
        assistantApiKey: "",
      };

      const client = await CadetPlatformClient.create();
      expect(client).toBeNull();
    });

    test("returns client with empty assistantId when assistant ID is missing", async () => {
      mockAssistantId = "";

      const client = await CadetPlatformClient.create();
      expect(client).not.toBeNull();
      expect(client!.platformAssistantId).toBe("");
    });

    test("strips trailing slash from platform base URL", async () => {
      mockManagedProxyCtx.cloudBaseUrl = "https://platform.example.com///";

      const client = await CadetPlatformClient.create();
      expect(client!.baseUrl).toBe("https://platform.example.com");
    });

    test("returns null when managed context is not rehydrated, even with stored credentials", async () => {
      mockManagedProxyCtx = {
        enabled: false,
        cloudBaseUrl: "",
        assistantApiKey: "",
      };
      mockAssistantId = "stored-assistant-id";
      reseedMemorySecureKeys(mockSecureKeys, {
        "cadet:assistant_api_key": "stored-api-key",
        "cadet:platform_assistant_id": " vault-assistant-id ",
      });

      // The base URL resolves from config or CADET_PLATFORM_URL only — the
      // credential store never carried it — so a disabled context has no
      // target to send the key to.
      const client = await CadetPlatformClient.create();

      expect(client).toBeNull();
    });
  });

  describe("isPlatformClientConfigured()", () => {
    test("true when base url, api key, and assistant id are all present", async () => {
      expect(await isPlatformClientConfigured()).toBe(true);
    });

    test("false when the platform assistant id is missing", async () => {
      mockAssistantId = "";

      expect(await isPlatformClientConfigured()).toBe(false);
    });

    test("false when auth prerequisites are missing", async () => {
      mockManagedProxyCtx = {
        enabled: false,
        cloudBaseUrl: "",
        assistantApiKey: "",
      };

      expect(await isPlatformClientConfigured()).toBe(false);
    });

    test("hung resolution answers false at the deadline, then serves the late result from cache", async () => {
      let releaseHang = () => {};
      const hang = new Promise<void>((resolve) => {
        releaseHang = resolve;
      });
      mockResolveManagedProxyContext = async () => {
        await hang;
        return mockManagedProxyCtx;
      };

      // Resolution is hung and no result has ever settled -- the deadline
      // must answer false instead of stalling the caller.
      expect(await isPlatformClientConfigured()).toBe(false);

      // Release the abandoned resolution; it settles true in the background
      // and refreshes the cache.
      releaseHang();
      await Bun.sleep(10);

      // Resolution hangs forever this time, but the cache answers true.
      mockResolveManagedProxyContext = () => new Promise(() => {});
      expect(await isPlatformClientConfigured()).toBe(true);
    });

    test("concurrent calls share a single in-flight resolution", async () => {
      let resolutionCount = 0;
      mockResolveManagedProxyContext = async () => {
        resolutionCount += 1;
        await Bun.sleep(5);
        return mockManagedProxyCtx;
      };

      const [first, second] = await Promise.all([
        isPlatformClientConfigured(),
        isPlatformClientConfigured(),
      ]);

      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(resolutionCount).toBe(1);
    });

    test("a settled flight clears, so the next call starts a fresh resolution", async () => {
      let resolutionCount = 0;
      mockResolveManagedProxyContext = async () => {
        resolutionCount += 1;
        return mockManagedProxyCtx;
      };

      expect(await isPlatformClientConfigured()).toBe(true);
      expect(await isPlatformClientConfigured()).toBe(true);
      expect(resolutionCount).toBe(2);
    });

    test("a caller that finds an abandoned flight rotates in a fresh resolution", async () => {
      let resolutionCount = 0;
      // The first resolution hangs forever; only the rotated-in second one
      // settles.
      const pendingHangs = [new Promise<void>(() => {})];
      mockResolveManagedProxyContext = async () => {
        resolutionCount += 1;
        const hang = pendingHangs.shift();
        if (hang) {
          await hang;
        }
        return mockManagedProxyCtx;
      };

      // The first caller abandons the hung flight at the deadline.
      expect(await isPlatformClientConfigured()).toBe(false);

      // The hung flight is marked abandoned, so the next caller rotates in a
      // fresh resolution instead of joining it; the fresh flight settles
      // immediately and answers live.
      expect(await isPlatformClientConfigured()).toBe(true);
      expect(resolutionCount).toBe(2);
    });

    test("a later caller joins a flight nobody has abandoned", async () => {
      let resolutionCount = 0;
      let release = () => {};
      // Gating the resolution keeps it in flight until the second caller has
      // joined, so the assertion does not race a settle.
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockResolveManagedProxyContext = async () => {
        resolutionCount += 1;
        await gate;
        return mockManagedProxyCtx;
      };

      const first = isPlatformClientConfigured();
      await Bun.sleep(1);
      const second = isPlatformClientConfigured();
      release();

      expect(await first).toBe(true);
      expect(await second).toBe(true);
      expect(resolutionCount).toBe(1);
    });

    test("a rotated-out flight's late settle cannot overwrite the newer flight's cached result", async () => {
      let releaseFirstHang = () => {};
      const firstHang = new Promise<void>((resolve) => {
        releaseFirstHang = resolve;
      });
      const pendingHangs = [firstHang];
      mockResolveManagedProxyContext = async () => {
        const hang = pendingHangs.shift();
        if (hang) {
          await hang;
        }
        return mockManagedProxyCtx;
      };

      // First caller abandons the hung flight; second caller rotates in a
      // fresh flight that settles true and writes the cache.
      expect(await isPlatformClientConfigured()).toBe(false);
      expect(await isPlatformClientConfigured()).toBe(true);

      // The rotated-out flight now settles resolving an unconfigured
      // context. Generation fencing must keep it from clobbering the newer
      // flight's cached `true`.
      mockManagedProxyCtx = {
        enabled: false,
        cloudBaseUrl: "",
        assistantApiKey: "",
      };
      releaseFirstHang();
      await Bun.sleep(10);

      // Resolution hangs forever, so this answer can only come from the
      // cache, which must still hold the newer flight's `true`.
      mockResolveManagedProxyContext = () => new Promise(() => {});
      expect(await isPlatformClientConfigured()).toBe(true);
    });
  });

  describe("fetch()", () => {
    test("prepends base URL to path", async () => {
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        expect(String(url)).toBe(
          "https://platform.example.com/v1/some/endpoint/",
        );
        return new Response("ok", { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      await client!.fetch("/v1/some/endpoint/");
    });

    test("injects Api-Key auth header", async () => {
      globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          expect(headers.get("Authorization")).toBe("Api-Key sk-test-key");
          return new Response("ok", { status: 200 });
        },
      ) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      await client!.fetch("/v1/test/");
    });

    test("preserves caller-provided headers", async () => {
      globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          expect(headers.get("Content-Type")).toBe("application/json");
          expect(headers.get("Authorization")).toBe("Api-Key sk-test-key");
          return new Response("ok", { status: 200 });
        },
      ) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      await client!.fetch("/v1/test/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    });

    test("passes through request init options", async () => {
      globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          expect(init?.method).toBe("POST");
          expect(init?.body).toBe('{"key":"value"}');
          return new Response("ok", { status: 200 });
        },
      ) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      await client!.fetch("/v1/test/", {
        method: "POST",
        body: '{"key":"value"}',
      });
    });
  });

  describe("getOwnerConsent()", () => {
    test("maps snake_case body to camelCase on 200", async () => {
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        expect(String(url)).toBe(
          "https://platform.example.com/v1/assistants/asst-123/owner-consent/",
        );
        return new Response(
          JSON.stringify({
            share_analytics: true,
            share_diagnostics: false,
            share_diagnostics_accepted_version: "2026-06-18",
          }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      const consent = await client!.getOwnerConsent();
      expect(consent).toEqual({
        shareAnalytics: true,
        shareDiagnostics: false,
        shareDiagnosticsAcceptedVersion: "2026-06-18",
      });
    });

    test("defaults shareDiagnosticsAcceptedVersion to '' when the platform omits it (back-compat)", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({ share_analytics: true, share_diagnostics: true }),
            { status: 200 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      const consent = await client!.getOwnerConsent();
      expect(consent).toEqual({
        shareAnalytics: true,
        shareDiagnostics: true,
        shareDiagnosticsAcceptedVersion: "",
      });
    });

    test("uses the authenticated Api-Key header", async () => {
      globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          expect(headers.get("Authorization")).toBe("Api-Key sk-test-key");
          return new Response(
            JSON.stringify({ share_analytics: true, share_diagnostics: true }),
            { status: 200 },
          );
        },
      ) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      await client!.getOwnerConsent();
    });

    test("returns null on 404", async () => {
      globalThis.fetch = mock(
        async () => new Response("not found", { status: 404 }),
      ) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      expect(await client!.getOwnerConsent()).toBeNull();
    });

    test("returns null on 500", async () => {
      globalThis.fetch = mock(
        async () => new Response("error", { status: 500 }),
      ) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      expect(await client!.getOwnerConsent()).toBeNull();
    });

    test("returns null on network error", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("network down");
      }) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      expect(await client!.getOwnerConsent()).toBeNull();
    });

    test("null share_analytics (owner never chose) maps to true — telemetry is opt-out", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({
              share_analytics: null,
              share_diagnostics: true,
              share_diagnostics_accepted_version: "2026-06-18",
            }),
            { status: 200 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      const consent = await client!.getOwnerConsent();
      expect(consent).toEqual({
        shareAnalytics: true,
        shareDiagnostics: true,
        shareDiagnosticsAcceptedVersion: "2026-06-18",
      });
    });

    test("explicit false is an opt-out", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({
              share_analytics: false,
              share_diagnostics: false,
              share_diagnostics_accepted_version: "2026-06-18",
            }),
            { status: 200 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      const consent = await client!.getOwnerConsent();
      expect(consent).toEqual({
        shareAnalytics: false,
        shareDiagnostics: false,
        shareDiagnosticsAcceptedVersion: "2026-06-18",
      });
    });

    test("null share_diagnostics (owner never chose) maps to true with the version gate still closed", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({
              share_analytics: null,
              share_diagnostics: null,
              share_diagnostics_accepted_version: "",
            }),
            { status: 200 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      const consent = await client!.getOwnerConsent();
      expect(consent).toEqual({
        shareAnalytics: true,
        shareDiagnostics: true,
        // "" keeps the PII trace-collection version gate fail-closed.
        shareDiagnosticsAcceptedVersion: "",
      });
    });

    test("returns null on malformed body (non-boolean fields)", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({ share_analytics: "yes", share_diagnostics: 1 }),
            { status: 200 },
          ),
      ) as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      expect(await client!.getOwnerConsent()).toBeNull();
    });

    test("returns null without fetching when assistantId is empty", async () => {
      mockAssistantId = "";
      reseedMemorySecureKeys(mockSecureKeys);

      const fetchSpy = mock(
        async () =>
          new Response(
            JSON.stringify({ share_analytics: true, share_diagnostics: true }),
            { status: 200 },
          ),
      );
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

      const client = await CadetPlatformClient.create();
      expect(client!.platformAssistantId).toBe("");
      expect(await client!.getOwnerConsent()).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
