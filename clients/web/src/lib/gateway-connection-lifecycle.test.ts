import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup } from "@testing-library/react";

import { setSelfHostedConnection } from "@/lib/self-hosted/connection";

let sessionUser: MockSessionUser | null = null;
let getSessionCallCount = 0;

type MockSessionUser = {
  id?: string;
  username?: string;
  email?: string;
};

let mockIsLocalClient = false;
let mockIsGatewayAuth = false;
// The assistant `getActiveAssistant()` resolves; `undefined` means none selected.
let mockSelectedAssistant:
  | {
      assistantId: string;
      cloud: string;
      runtimeUrl?: string;
    }
  | undefined;
let mockPrimeError: Error | null = null;
const primeLocalGatewayConnectionMock = mock(
  async (_target?: { assistantId: string; cloud: string }) => {
    if (mockPrimeError) {
      throw mockPrimeError;
    }
  },
);
const primeLocalGatewayConnectionWithStartupRetryMock = mock(async () => {
  if (mockPrimeError) {
    throw mockPrimeError;
  }
});
const primeLocalGatewayConnectionWithRepairMock = mock(async () => {
  if (mockPrimeError) {
    throw mockPrimeError;
  }
});
const logoutMock = mock(async () => {});

mock.module("@/lib/auth/allauth-client", () => ({
  getSession: async () => {
    getSessionCallCount++;
    if (!sessionUser) {
      return {
        ok: false,
        status: 401,
        error: { detail: "Unauthorized" },
      };
    }
    return { ok: true, data: { user: sessionUser } };
  },
  logout: logoutMock,
}));

mock.module("@/lib/local-mode", () => ({
  isLocalClient: () => mockIsLocalClient,
  isLocalAssistant: (a: { cloud?: string }) => a.cloud === "local",
  isCloudAssistant: (a: { cloud?: string }) => a.cloud === "cadet",
  isCadetCloudRemote: () => false,
  isServedGatewayRuntime: () => false,
  hasGatewayAssistant: () => mockIsGatewayAuth,
  hasPairedGateway: (
    a: { assistantId: string; runtimeUrl?: string } | undefined,
  ) => !!a && !!a.runtimeUrl,
  hasLocalGateway: (
    a: { assistantId: string; runtimeUrl?: string } | undefined,
  ) => !!a && !a.runtimeUrl,
  getCloudAssistants: () => [],
  getLocalAssistants: () => [],
  getActiveAssistant: () => mockSelectedAssistant,
  getServedLockfile: () => ({ assistants: [], activeAssistant: null }),
  getLockfileAssistant: () => undefined,
  primeLocalGatewayConnection: primeLocalGatewayConnectionMock,
  primeLocalGatewayConnectionWithStartupRetry:
    primeLocalGatewayConnectionWithStartupRetryMock,
  primeLocalGatewayConnectionWithRepair:
    primeLocalGatewayConnectionWithRepairMock,
}));

mock.module("@/lib/auth/remote-gateway-session", () => ({
  remoteGatewayPublicPathPrefix: () => "",
  remoteGatewayPublicBaseUrl: () => "",
}));

mock.module("@/lib/local-cloud-identity", () => ({
  bootstrapLocalAssistantCloudIdentity: async () => {},
  resolveLocalAssistantCloudIdentity: async (id: string) => id,
  fetchCloudStatus: async () => null,
  isUuid: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => false,
  isOAuthFlowInFlight: () => false,
  installSessionCookies: () => {},
  waitForNativeSessionCookie: async () => {},
}));

mock.module("@/runtime/native-biometric", () => ({
  deleteBiometricToken: async () => {},
  isBiometricEnabled: () => false,
  setBiometricEnabled: (_enabled: boolean) => {},
  storeBiometricToken: async () => false,
  retrieveBiometricToken: async () => null,
  getBiometricCapability: async () => null,
}));

mock.module("@/lib/auth/session-cleanup", () => ({
  clearUserScopedStorage: () => {},
}));

// Full module surface: `mock.module` is process-global in bun, so a partial
// shape would shadow the other exports for later test files.
const clearWidgetSnapshotMock = mock(async () => true);
mock.module("@/runtime/widget-snapshot", () => ({
  WIDGET_SNAPSHOT_SCHEMA_VERSION: 2,
  isWidgetSnapshotSyncAvailable: () => false,
  readWidgetSnapshotAssistantId: () => null,
  syncWidgetSnapshot: async () => false,
  clearWidgetSnapshot: clearWidgetSnapshotMock,
  retryPendingWidgetSnapshotClear: async () => true,
}));

const notificationAvatarRuntime = await import("@/runtime/notification-avatar");

function seedNotificationIdentityMemory() {
  const identity = notificationAvatarRuntime.createNotificationIdentity(
    '["account","user-123","org-abc"]',
    "assistant-1",
    "00000000-0000-4000-8000-000000000001",
  )!;
  const publication =
    notificationAvatarRuntime.beginNotificationIdentityPublication(identity);
  notificationAvatarRuntime.publishPreparedNotificationIdentity(publication, {
    name: "Assistant One",
    nameProvenance: "identity-store",
  });
  return identity;
}

// The lifecycle writes the selection through the public wrapper, not a
// store action — mock the wrapper module so the real one (and its
// local-mode deps) never loads.
const setSelectedAssistantMock = mock(async (_id: string | null) => {});
mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: setSelectedAssistantMock,
}));

// Don't mock `@/lib/event-bus` — bun's `mock.module` is process-global, so
// any stub here would shadow the real bus for every later test file in the
// run.

const {
  establishGatewayConnection,
  reverifyGatewayConnection,
} = await import("@/lib/gateway-connection-lifecycle");

beforeEach(() => {
  sessionUser = null;
  getSessionCallCount = 0;
  setSelfHostedConnection(null);
  mockIsLocalClient = false;
  mockIsGatewayAuth = false;
  mockSelectedAssistant = undefined;
  mockPrimeError = null;
  setSelectedAssistantMock.mockClear();
  primeLocalGatewayConnectionMock.mockClear();
  primeLocalGatewayConnectionWithStartupRetryMock.mockClear();
  primeLocalGatewayConnectionWithRepairMock.mockClear();
  clearWidgetSnapshotMock.mockClear();
  notificationAvatarRuntime.__clearNotificationIdentitySnapshotsForTests();
});

afterEach(() => {
  cleanup();
});

describe("establishGatewayConnection", () => {
  test("the public pair page tears down retained session state without pinging anything", async () => {
    window.history.pushState({}, "", "/assistant/pair");
    try {
      await establishGatewayConnection();

      expect(
        primeLocalGatewayConnectionWithStartupRetryMock,
      ).not.toHaveBeenCalled();
      expect(getSessionCallCount).toBe(0);
      expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  test("restores the local gateway connection through the startup-retry prime", async () => {
    // The boot restore must ride out the gateway's reboot startup window rather
    // than the bare prime, so a transient "starting" failure doesn't drop the
    // persisted local assistant to the recovery controls.
    mockIsLocalClient = true;
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };

    await establishGatewayConnection();

    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).toHaveBeenCalledTimes(1);
    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
  });

  test("an exhausted startup-retry prime ends the session", async () => {
    mockIsLocalClient = true;
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    mockPrimeError = new Error("Gateway token request failed: 401");

    await establishGatewayConnection();

    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).toHaveBeenCalledTimes(1);
    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
  });

  test("boot with no gateway machinery does nothing", async () => {
    await establishGatewayConnection();

    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).not.toHaveBeenCalled();
    expect(getSessionCallCount).toBe(0);
    expect(clearWidgetSnapshotMock).not.toHaveBeenCalled();
  });
});

describe("reverifyGatewayConnection", () => {
  test("re-primes a paired selection and never fetches the SPA origin's /auth/token", async () => {
    mockSelectedAssistant = {
      assistantId: "paired-a",
      cloud: "local",
      runtimeUrl: "https://gw.example.com",
    };
    const fetchedUrls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchedUrls.push(String(input));
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch;
    try {
      await reverifyGatewayConnection();
    } finally {
      globalThis.fetch = realFetch;
    }

    // Both selection kinds collapse into the tokenless prime — it takes no
    // target and resolves the selection itself.
    expect(primeLocalGatewayConnectionMock).toHaveBeenCalledTimes(1);
    expect(primeLocalGatewayConnectionMock).toHaveBeenCalledWith();
    expect(fetchedUrls).toEqual([]);
  });

  test("rotates a local selection's gateway JWT through the prime", async () => {
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };

    await reverifyGatewayConnection();

    expect(primeLocalGatewayConnectionMock).toHaveBeenCalledTimes(1);
  });

  test("a failed gateway re-verification ends the session", async () => {
    const identity = seedNotificationIdentityMemory();
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    mockPrimeError = new Error("paired proxy authorization failed");

    await reverifyGatewayConnection();

    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
    expect(
      notificationAvatarRuntime.getNotificationIdentitySnapshot(identity),
    ).toBeNull();
  });

  test("a re-verification with no selection touches nothing", async () => {
    await reverifyGatewayConnection();

    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
    expect(getSessionCallCount).toBe(0);
    expect(clearWidgetSnapshotMock).not.toHaveBeenCalled();
  });
});
