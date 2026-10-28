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

type MockSessionUser = {
  id?: string;
  username?: string;
  email?: string;
};

let mockIsLocalClient = false;
// The assistant `getActiveAssistant()` resolves; `undefined` means none selected.
let mockSelectedAssistant:
  | {
      assistantId: string;
      cloud: string;
      runtimeUrl?: string;
    }
  | undefined;
let mockLockfileAssistants: Array<{
  assistantId: string;
  cloud: string;
  runtimeUrl?: string;
}> = [];
let mockPrimeError: Error | null = null;
const setSelectedAssistantMock = mock(async (_id: string | null) => {});
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
const bootstrapLocalAssistantCloudIdentityMock = mock(
  (_assistantId?: string) => {},
);

mock.module("@/lib/auth/allauth-client", () => ({
  getSession: async () => {
    if (!sessionUser) {
      return {
        ok: false,
        status: 401,
        error: { detail: "Unauthorized" },
      };
    }
    return { ok: true, data: { user: sessionUser } };
  },
  logout: async () => {},
}));

mock.module("@/lib/local-mode", () => ({
  isLocalClient: () => mockIsLocalClient,
  isLocalAssistant: (a: { cloud?: string }) => a.cloud === "local",
  isCloudAssistant: (a: { cloud?: string }) => a.cloud === "cadet",
  isCadetCloudRemote: () => false,
  isServedGatewayRuntime: () => false,
  hasGatewayAddress: (a: { assistantId: string } | undefined) => !!a,
  hasLocalGateway: (
    a: { assistantId: string; runtimeUrl?: string } | undefined,
  ) => !!a && !a.runtimeUrl,
  getCloudAssistants: () => [],
  getLocalAssistants: () =>
    mockSelectedAssistant ? [mockSelectedAssistant] : [],
  getActiveAssistant: () => mockSelectedAssistant,
  getServedLockfile: () => ({ assistants: [], activeAssistant: null }),
  getLockfileAssistant: (id: string) =>
    mockLockfileAssistants.find((a) => a.assistantId === id),
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
  bootstrapLocalAssistantCloudIdentity:
    bootstrapLocalAssistantCloudIdentityMock,
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
mock.module("@/runtime/widget-snapshot", () => ({
  WIDGET_SNAPSHOT_SCHEMA_VERSION: 2,
  isWidgetSnapshotSyncAvailable: () => false,
  readWidgetSnapshotAssistantId: () => null,
  syncWidgetSnapshot: async () => false,
  clearWidgetSnapshot: async () => true,
  retryPendingWidgetSnapshotClear: async () => true,
}));

// The connect flow writes the selection through the public wrapper, not the
// store action — mock the wrapper module so the real one (and its
// local-mode deps) never loads.
mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: setSelectedAssistantMock,
}));

// Don't mock `@/lib/event-bus` — bun's `mock.module` is process-global, so
// any stub here would shadow the real bus for every later test file in the
// run.

const { connectCloudAssistant } = await import(
  "@/assistant/connect-assistant"
);

beforeEach(() => {
  sessionUser = null;
  setSelfHostedConnection(null);
  mockIsLocalClient = false;
  mockSelectedAssistant = undefined;
  mockLockfileAssistants = [];
  mockPrimeError = null;
  setSelectedAssistantMock.mockClear();
  primeLocalGatewayConnectionMock.mockClear();
  primeLocalGatewayConnectionWithStartupRetryMock.mockClear();
  primeLocalGatewayConnectionWithRepairMock.mockClear();
  bootstrapLocalAssistantCloudIdentityMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("connectCloudAssistant", () => {
  test("requires a live platform session", async () => {
    sessionUser = null;

    await expect(connectCloudAssistant("cloud-1")).rejects.toThrow(
      "Platform authentication required",
    );
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });

  test("selects the assistant when the session is live", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };

    await connectCloudAssistant("cloud-1");

    expect(setSelectedAssistantMock).toHaveBeenCalledWith("cloud-1");
    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
  });
});
