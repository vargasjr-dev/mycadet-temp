/**
 * Tests for ATL-433: /v1/pair validates Origin against KNOWN_EXTENSION_ORIGINS,
 * and resolveExtensionOrigin uses the same allowlist.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

import { initSigningKey } from "../auth/token-service.js";
import { setTestSigningKey } from "./helpers/signing-key.js";

// Must init signing key before any module that mints tokens is imported.
setTestSigningKey();
initSigningKey();

// Mock DB — pair.ts calls resolveLocalGuardianPrincipalId() which queries the DB.
const mockQuery = mock();
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mockQuery,
  assistantDbRun: mock(),
  assistantDbExec: mock(),
}));

const { resetPairRateLimiterForTests } = await import("../http/routes/pair.js");
const { resolveExtensionOrigin, corsHeaders, extensionCorsHeaders } =
  await import("../http/middleware/cors.js");
const { KNOWN_EXTENSION_ORIGINS } =
  await import("../chrome-extension-origins.js");
const { CLIENT_METADATA_HEADERS } =
  await import("@mycadet/service-contracts/client-metadata");

// A non-Cadet extension origin.
const MALICIOUS_ORIGIN =
  "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(() => {
  resetPairRateLimiterForTests();
  mockQuery.mockResolvedValue([{ principalId: "guardian-001" }]);
});

// ---------------------------------------------------------------------------
// resolveExtensionOrigin — allowlist behaviour
// ---------------------------------------------------------------------------

describe("resolveExtensionOrigin", () => {
  test("returns origin for every known Cadet extension ID", () => {
    for (const origin of KNOWN_EXTENSION_ORIGINS) {
      const req = new Request("http://localhost:7830/v1/events", {
        headers: { origin },
      });
      expect(resolveExtensionOrigin(req)).toBe(origin);
    }
  });

  test("returns null for an unknown chrome-extension:// origin", () => {
    const req = new Request("http://localhost:7830/v1/events", {
      headers: { origin: MALICIOUS_ORIGIN },
    });
    expect(resolveExtensionOrigin(req)).toBeNull();
  });

  test("returns null when Origin header is absent", () => {
    const req = new Request("http://localhost:7830/v1/events");
    expect(resolveExtensionOrigin(req)).toBeNull();
  });

  test("returns null for a non-extension origin (web page)", () => {
    const req = new Request("http://localhost:7830/v1/events", {
      headers: { origin: "https://evil.example.com" },
    });
    expect(resolveExtensionOrigin(req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Webview CORS — client-metadata analytics headers
// ---------------------------------------------------------------------------

describe("extension CORS headers", () => {
  test("allows the client version and watchdog fingerprints", () => {
    const origin = [...KNOWN_EXTENSION_ORIGINS][0];
    const headers = extensionCorsHeaders(origin);
    const allowHeaders =
      headers["Access-Control-Allow-Headers"]?.toLowerCase() ?? "";
    expect(allowHeaders).toContain("x-cadet-client-version");
    expect(allowHeaders).toContain("x-cadet-sse-watchdog");
  });
});

describe("webview CORS headers", () => {
  test("Access-Control-Allow-Headers includes client version and watchdog fingerprints", () => {
    const headers = corsHeaders("https://app.cadet.local");
    const allowHeaders =
      headers["Access-Control-Allow-Headers"]?.toLowerCase() ?? "";
    expect(allowHeaders).toContain("x-cadet-client-version");
    expect(allowHeaders).toContain("x-cadet-sse-watchdog");
  });

  test("Access-Control-Allow-Headers includes every client-metadata header", () => {
    const headers = corsHeaders("https://app.cadet.local");
    const allowHeaders =
      headers["Access-Control-Allow-Headers"]?.toLowerCase() ?? "";
    for (const header of Object.values(CLIENT_METADATA_HEADERS)) {
      expect(allowHeaders).toContain(header);
    }
  });
});
