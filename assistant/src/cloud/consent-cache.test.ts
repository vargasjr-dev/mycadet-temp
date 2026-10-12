import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { OwnerConsent } from "./client.js";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockClient: {
  cloudAssistantId: string;
  getOwnerConsent: () => Promise<OwnerConsent | null>;
} | null = null;
let createCallCount = 0;

// ---------------------------------------------------------------------------
// Module mocks (must precede the import under test)
// ---------------------------------------------------------------------------

mock.module("./client.js", () => ({
  CadetCloudClient: {
    create: async () => {
      createCallCount += 1;
      return mockClient;
    },
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  __setCachedShareDiagnosticsForTest,
  getCachedShareDiagnostics,
  refreshConsentCache,
  startConsentRefresh,
  stopConsentRefresh,
} from "./consent-cache.js";

/**
 * Build a mock owner consent. Fields default to `false` so diagnostics-only
 * cases don't have to spell them out.
 */
function makeConsent(overrides: Partial<OwnerConsent> = {}): OwnerConsent {
  return {
    shareAnalytics: false,
    shareDiagnostics: false,
    shareDiagnosticsAcceptedVersion: "",
    ...overrides,
  };
}

function makeClient(consent: OwnerConsent | null, assistantId = "asst_1") {
  return {
    cloudAssistantId: assistantId,
    getOwnerConsent: async () => consent,
  };
}

describe("consent-cache", () => {
  beforeEach(() => {
    mockClient = null;
    createCallCount = 0;
    // Boot state: no confirmed consent yet.
    __setCachedShareDiagnosticsForTest("unknown");
  });

  afterEach(async () => {
    await stopConsentRefresh();
  });

  test("no cloud client available → diagnostics stay fail-closed", async () => {
    mockClient = null;
    await refreshConsentCache();
    expect(getCachedShareDiagnostics()).toBe(false);
  });

  test("cloud features disabled → diagnostics confirmed false, not unknown", async () => {
    __setCachedShareDiagnosticsForTest("unknown");
    process.env.CADET_DISABLE_CLOUD = "1";
    try {
      await refreshConsentCache();
    } finally {
      delete process.env.CADET_DISABLE_CLOUD;
    }
    expect(getCachedShareDiagnostics()).toBe(false);
  });

  test("becomes true after a successful fetch reporting shareDiagnostics: true", async () => {
    mockClient = makeClient(makeConsent({ shareDiagnostics: true }));
    await refreshConsentCache();
    expect(getCachedShareDiagnostics()).toBe(true);
  });

  test("a null fetch keeps the last known value", async () => {
    mockClient = makeClient(makeConsent({ shareDiagnostics: true }));
    await refreshConsentCache();
    expect(getCachedShareDiagnostics()).toBe(true);

    // Transient failure: consent endpoint returns null.
    mockClient = makeClient(null);
    await refreshConsentCache();
    expect(getCachedShareDiagnostics()).toBe(true);
  });

  test("a missing client demotes a prior diagnostics opt-in to fail-closed", async () => {
    __setCachedShareDiagnosticsForTest(true);
    mockClient = null;
    await refreshConsentCache();
    expect(getCachedShareDiagnostics()).toBe(false);
  });

  test("a client without a resolvable assistant identity demotes diagnostics", async () => {
    __setCachedShareDiagnosticsForTest(true);
    mockClient = makeClient(makeConsent({ shareDiagnostics: true }), "");
    await refreshConsentCache();
    expect(getCachedShareDiagnostics()).toBe(false);
  });

  test("startConsentRefresh is idempotent and runs an immediate refresh", async () => {
    mockClient = makeClient(makeConsent({ shareDiagnostics: true }));

    startConsentRefresh();
    startConsentRefresh(); // no-op: timer already running
    // Let the fire-and-forget immediate refresh settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getCachedShareDiagnostics()).toBe(true);
    // One immediate refresh from the first call; the second is a no-op.
    expect(createCallCount).toBe(1);
  });

  test("stopConsentRefresh clears the timer (start can run again)", async () => {
    startConsentRefresh();
    await stopConsentRefresh();
    // A fresh start after stop performs another immediate refresh.
    mockClient = makeClient(makeConsent({ shareDiagnostics: true }));
    startConsentRefresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getCachedShareDiagnostics()).toBe(true);
  });
});
