import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  reseedMemorySecureKeys,
  useMemorySecureKeys,
} from "../__tests__/helpers/secure-keys.js";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockCloudProxyCtx = {
  enabled: false,
  cloudBaseUrl: "",
  assistantApiKey: "",
};
let mockAssistantId = "";
const mockSecureKeys = useMemorySecureKeys();
// Re-pointable so the probe-deadline tests can hang context resolution.
let mockResolveCloudProxyContext: () => Promise<
  typeof mockCloudProxyCtx
> = async () => mockCloudProxyCtx;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

mock.module("../providers/cloud-proxy/context.js", () => ({
  resolveCloudProxyContext: () => mockResolveCloudProxyContext(),
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
  CadetCloudClient,
  isCloudClientConfigured,
} from "./client.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CadetCloudClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockCloudProxyCtx = {
      enabled: true,
      cloudBaseUrl: "https://platform.example.com",
      assistantApiKey: "sk-test-key",
    };
    mockAssistantId = "asst-123";
    reseedMemorySecureKeys(mockSecureKeys);
    mockResolveCloudProxyContext = async () => mockCloudProxyCtx;
    _resetConfiguredProbeCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("create()", () => {
    test("returns a client when all prerequisites are met", async () => {
      const client = await CadetCloudClient.create();
      expect(client).not.toBeNull();
      expect(client!.baseUrl).toBe("https://platform.example.com");
      expect(client!.assistantApiKey).toBe("sk-test-key");
      expect(client!.cloudAssistantId).toBe("asst-123");
    });

    test("returns null when cloud proxy is not enabled", async () => {
      mockCloudProxyCtx = {
        enabled: false,
        cloudBaseUrl: "",
        assistantApiKey: "",
      };

      const client = await CadetCloudClient.create();
      expect(client).toBeNull();
    });

    test("returns client with empty assistantId when assistant ID is missing", async () => {
      mockAssistantId = "";

      const client = await CadetCloudClient.create();
      expect(client).not.toBeNull();
      expect(client!.cloudAssistantId).toBe("");
    });

    test("strips trailing slash from platform base URL", async () => {
      mockCloudProxyCtx.cloudBaseUrl = "https://platform.example.com///";

      const client = await CadetCloudClient.create();
      expect(client!.baseUrl).toBe("https://platform.example.com");
    });

    test("returns null when managed context is not rehydrated, even with stored credentials", async () => {
      mockCloudProxyCtx = {
        enabled: false,
        cloudBaseUrl: "",
        assistantApiKey: "",
      };
      mockAssistantId = "stored-assistant-id";
      reseedMemorySecureKeys(mockSecureKeys, {
        "cadet:assistant_api_key": "stored-api-key",
        "cadet:platform_assistant_id": " vault-assistant-id ",
      });

      // The base URL resolves from config or CADET_CLOUD_URL only — the
      // credential store never carried it — so a disabled context has no
      // target to send the key to.
      const client = await CadetCloudClient.create();

      expect(client).toBeNull();
    });
  });

  describe("isCloudClientConfigured()", () => {
    test("true when base url, api key, and assistant id are all present", async () => {
      expect(await isCloudClientConfigured()).toBe(true);
    });

    test("false when the cloud assistant id is missing", async () => {
      mockAssistantId = "";

      expect(await isCloudClientConfigured()).toBe(false);
    });

    test("false when auth prerequisites are missing", async () => {
      mockCloudProxyCtx = {
        enabled: false,
        cloudBaseUrl: "",
        assistantApiKey: "",
      };

      expect(await isCloudClientConfigured()).toBe(false);
    });

    test("hung resolution answers false at the deadline, then serves the late result from cache", async () => {
      let releaseHang = () => {};
      const hang = new Promise<void>((resolve) => {
        releaseHang = resolve;
      });
      mockResolveCloudProxyContext = async () => {
        await hang;
        return mockCloudProxyCtx;
      };

      // Resolution is hung and no result has ever settled -- the deadline
      // must answer false instead of stalling the caller.
      expect(await isCloudClientConfigured()).toBe(false);

      // Release the abandoned resolution; it settles true in the background
      // and refreshes the cache.
      releaseHang();
      await Bun.sleep(10);

      // Resolution hangs forever this time, but the cache answers true.
      mockResolveCloudProxyContext = () => new Promise(() => {});
      expect(await isCloudClientConfigured()).toBe(true);
    });

    test("concurrent calls share a single in-flight resolution", async () => {
      let resolutionCount = 0;
      mockResolveCloudProxyContext = async () => {
        resolutionCount += 1;
        await Bun.sleep(5);
        return mockCloudProxyCtx;
      };

      const [first, second] = await Promise.all([
        isCloudClientConfigured(),
        isCloudClientConfigured(),
      ]);

      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(resolutionCount).toBe(1);
    });

    test("a settled flight clears, so the next call starts a fresh resolution", async () => {
      let resolutionCount = 0;
      mockResolveCloudProxyContext = async () => {
        resolutionCount += 1;
        return mockCloudProxyCtx;
      };

      expect(await isCloudClientConfigured()).toBe(true);
      expect(await isCloudClientConfigured()).toBe(true);
      expect(resolutionCount).toBe(2);
    });

    test("a caller that finds an abandoned flight rotates in a fresh resolution", async () => {
      let resolutionCount = 0;
      // The first resolution hangs forever; only the rotated-in second one
      // settles.
      const pendingHangs = [new Promise<void>(() => {})];
      mockResolveCloudProxyContext = async () => {
        resolutionCount += 1;
        const hang = pendingHangs.shift();
        if (hang) {
          await hang;
        }
        return mockCloudProxyCtx;
      };

      // The first caller abandons the hung flight at the deadline.
      expect(await isCloudClientConfigured()).toBe(false);

      // The hung flight is marked abandoned, so the next caller rotates in a
      // fresh resolution instead of joining it; the fresh flight settles
      // immediately and answers live.
      expect(await isCloudClientConfigured()).toBe(true);
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
      mockResolveCloudProxyContext = async () => {
        resolutionCount += 1;
        await gate;
        return mockCloudProxyCtx;
      };

      const first = isCloudClientConfigured();
      await Bun.sleep(1);
      const second = isCloudClientConfigured();
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
      mockResolveCloudProxyContext = async () => {
        const hang = pendingHangs.shift();
        if (hang) {
          await hang;
        }
        return mockCloudProxyCtx;
      };

      // First caller abandons the hung flight; second caller rotates in a
      // fresh flight that settles true and writes the cache.
      expect(await isCloudClientConfigured()).toBe(false);
      expect(await isCloudClientConfigured()).toBe(true);

      // The rotated-out flight now settles resolving an unconfigured
      // context. Generation fencing must keep it from clobbering the newer
      // flight's cached `true`.
      mockCloudProxyCtx = {
        enabled: false,
        cloudBaseUrl: "",
        assistantApiKey: "",
      };
      releaseFirstHang();
      await Bun.sleep(10);

      // Resolution hangs forever, so this answer can only come from the
      // cache, which must still hold the newer flight's `true`.
      mockResolveCloudProxyContext = () => new Promise(() => {});
      expect(await isCloudClientConfigured()).toBe(true);
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

      const client = await CadetCloudClient.create();
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

      const client = await CadetCloudClient.create();
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

      const client = await CadetCloudClient.create();
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

      const client = await CadetCloudClient.create();
      await client!.fetch("/v1/test/", {
        method: "POST",
        body: '{"key":"value"}',
      });
    });
  });
});
