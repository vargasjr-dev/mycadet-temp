import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup } from "@testing-library/react";

import {
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";

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
const setSelectedAssistantMock = mock(async (_id: string | null) => {});
const logoutMock = mock(async () => {});
const deleteBiometricTokenMock = mock(async () => {});

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
  logout: logoutMock,
}));

mock.module("@/lib/local-mode", () => ({
  isLocalClient: () => mockIsLocalClient,
  isLocalAssistant: (a: { cloud?: string }) => a.cloud === "local",
  isCloudAssistant: (a: { cloud?: string }) => a.cloud === "cadet",
  isCadetCloudRemote: () => false,
  isServedGatewayRuntime: () => false,
  hasGatewayAssistant: () => false,
  isRemoteGatewayEntry: () => false,
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
  primeLocalGatewayConnection: async () => {},
  primeLocalGatewayConnectionWithStartupRetry: async () => {},
  primeLocalGatewayConnectionWithRepair: async () => {},
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
  deleteBiometricToken: deleteBiometricTokenMock,
  isBiometricEnabled: () => false,
  setBiometricEnabled: (_enabled: boolean) => {},
  storeBiometricToken: async () => false,
  retrieveBiometricToken: async () => null,
  getBiometricCapability: async () => null,
}));

const clearUserScopedStorageMock = mock(() => {});

mock.module("@/lib/auth/session-cleanup", () => ({
  clearUserScopedStorage: clearUserScopedStorageMock,
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

// The teardown writes the selection through the public wrapper, not the
// store action — mock the wrapper module so the real one (and its
// local-mode deps) never loads.
mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: setSelectedAssistantMock,
}));

// Don't mock `@/lib/event-bus` — bun's `mock.module` is process-global, so
// any stub here would shadow the real bus for every later test file in the
// run.

const { teardownSession } = await import("@/lib/auth/session-teardown");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");

beforeEach(() => {
  sessionUser = null;
  setSelfHostedConnection(null);
  mockIsLocalClient = false;
  mockSelectedAssistant = undefined;
  setSelectedAssistantMock.mockClear();
  clearUserScopedStorageMock.mockClear();
  clearWidgetSnapshotMock.mockClear();
  notificationAvatarRuntime.__clearNotificationIdentitySnapshotsForTests();
  logoutMock.mockClear();
  deleteBiometricTokenMock.mockClear();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

afterEach(() => {
  cleanup();
});

describe("teardownSession", () => {
  test("teardown clears biometric token", async () => {
    await teardownSession();

    expect(deleteBiometricTokenMock).toHaveBeenCalled();
  });

  test("teardown clears user-scoped browser storage", async () => {
    await teardownSession();

    expect(clearUserScopedStorageMock).toHaveBeenCalled();
  });

  test("teardown drops the widget snapshot and the notification identity", async () => {
    const identity = seedNotificationIdentityMemory();
    await teardownSession();

    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
    expect(
      notificationAvatarRuntime.getNotificationIdentitySnapshot(identity),
    ).toBeNull();
  });

  // The active-id clear must run BEFORE the selection clear in both
  // branches so subscribers never observe a stale assistant id in their
  // first re-render after the session ends.
  test("self-hosted teardown clears the active id before clearing the selection", async () => {
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    const order: string[] = [];
    const unsubscribe = useResolvedAssistantsStore.subscribe((state) => {
      if (state.activeAssistantId === null) {
        order.push("reset");
      }
    });
    setSelectedAssistantMock.mockImplementationOnce(async (id) => {
      order.push(`clear:${String(id)}`);
    });

    try {
      await teardownSession();
    } finally {
      unsubscribe();
    }

    expect(order).toEqual(["reset", "clear:null"]);
  });

  test("self-hosted teardown clears the paired proxy authorization", async () => {
    mockSelectedAssistant = {
      assistantId: "paired-1",
      cloud: "local",
      runtimeUrl: "https://gw.example.com",
    };
    setSelfHostedConnection({
      url: window.location.origin,
      token: null,
    });
    setSelectedAssistantMock.mockImplementationOnce(async () => {
      expect(getSelfHostedIngressUrl()).toBeNull();
    });

    await teardownSession();

    expect(getSelfHostedIngressUrl()).toBeNull();
  });

  test("platform teardown clears the selection slice after the active-id clear", async () => {
    const order: string[] = [];
    const unsubscribe = useResolvedAssistantsStore.subscribe((state) => {
      if (state.activeAssistantId === null) {
        order.push("reset");
      }
    });
    setSelectedAssistantMock.mockImplementationOnce(async (id) => {
      order.push(`clear:${String(id)}`);
    });

    try {
      await teardownSession();
    } finally {
      unsubscribe();
    }

    expect(order).toEqual(["reset", "clear:null"]);
  });

  test("self-hosted teardown never revokes the platform session", async () => {
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    await teardownSession();
    expect(logoutMock).not.toHaveBeenCalled();
  });
});
