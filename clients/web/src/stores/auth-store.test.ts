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
let mockLockfileAssistants: Array<{ assistantId: string; cloud: string }> = [];
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
const logoutMock = mock(async () => {});
const deleteBiometricTokenMock = mock(async () => {});
let mockIsBiometricEnabled = false;
const retrieveBiometricTokenMock = mock(async () => null);
const bootstrapLocalAssistantCloudIdentityMock = mock(
  (_assistantId?: string) => {},
);

// The real predicate, applied against the contract helpers directly: the
// paired-connect tests seed `cloud: "local"` + an off-machine runtimeUrl,
// which is exactly what makes an entry a paired target.
import {
  isLoopbackGatewayCloud,
  isUsableRuntimeUrl,
} from "@mycadet/local-mode/contract";
const isRemoteGatewayEntryMock = (entry: {
  cloud: Parameters<typeof isLoopbackGatewayCloud>[0];
  runtimeUrl?: string;
}): boolean =>
  isLoopbackGatewayCloud(entry.cloud) &&
  isUsableRuntimeUrl(entry.runtimeUrl);

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
  getLockfileAssistant: (id: string) =>
    mockLockfileAssistants.find((a) => a.assistantId === id),
  isRemoteGatewayEntry: isRemoteGatewayEntryMock,
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
  deleteBiometricToken: deleteBiometricTokenMock,
  isBiometricEnabled: () => mockIsBiometricEnabled,
  setBiometricEnabled: (_enabled: boolean) => {},
  storeBiometricToken: async () => false,
  retrieveBiometricToken: retrieveBiometricTokenMock,
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

// Auth-store writes the selection through the public wrapper, not the store
// action — mock the wrapper module so the real one (and its local-mode deps)
// never loads.
mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: setSelectedAssistantMock,
}));

// Don't mock `@/lib/event-bus` — bun's `mock.module` is process-global, so
// any stub here would shadow the real bus for every later test file in the
// run.

const { useAuthStore } = await import("@/stores/auth-store");
const { connectCloudAssistant, connectLocalAssistant, connectPairedAssistant } =
  await import("@/assistant/connect-assistant");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");

beforeEach(() => {
  sessionUser = null;
  getSessionCallCount = 0;
  setSelfHostedConnection(null);
  mockIsLocalClient = false;
  mockIsGatewayAuth = false;
  mockSelectedAssistant = undefined;
  mockLockfileAssistants = [];
  mockPrimeError = null;
  mockIsBiometricEnabled = false;
  setSelectedAssistantMock.mockClear();
  primeLocalGatewayConnectionMock.mockClear();
  primeLocalGatewayConnectionWithStartupRetryMock.mockClear();
  primeLocalGatewayConnectionWithRepairMock.mockClear();
  clearUserScopedStorageMock.mockClear();
  clearWidgetSnapshotMock.mockClear();
  notificationAvatarRuntime.__clearNotificationIdentitySnapshotsForTests();
  logoutMock.mockClear();
  deleteBiometricTokenMock.mockClear();
  bootstrapLocalAssistantCloudIdentityMock.mockClear();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

afterEach(() => {
  cleanup();
});

describe("initSession", () => {
  test("the public pair page tears down retained session state without pinging anything", async () => {
    mockIsGatewayAuth = true;
    window.history.pushState({}, "", "/assistant/pair");
    try {
      await useAuthStore.getState().initSession();

      expect(
        primeLocalGatewayConnectionWithStartupRetryMock,
      ).not.toHaveBeenCalled();
      expect(getSessionCallCount).toBe(0);
      expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  test("restores the local gateway session through the startup-retry prime", async () => {
    // The boot restore must ride out the gateway's reboot startup window rather
    // than the bare prime, so a transient "starting" failure doesn't drop the
    // persisted local assistant to the recovery controls.
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };

    await useAuthStore.getState().initSession();

    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).toHaveBeenCalledTimes(1);
    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
  });

  test("an exhausted startup-retry prime ends the session", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    mockPrimeError = new Error("Gateway token request failed: 401");

    await useAuthStore.getState().initSession();

    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).toHaveBeenCalledTimes(1);
    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
  });

  test("boot with no gateway machinery does nothing", async () => {
    await useAuthStore.getState().initSession();

    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).not.toHaveBeenCalled();
    expect(getSessionCallCount).toBe(0);
    expect(clearWidgetSnapshotMock).not.toHaveBeenCalled();
  });
});

describe("refreshSession", () => {
  test("re-primes a paired selection and never fetches the SPA origin's /auth/token", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
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
      await useAuthStore.getState().refreshSession();
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
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };

    await useAuthStore.getState().refreshSession();

    expect(primeLocalGatewayConnectionMock).toHaveBeenCalledTimes(1);
  });

  test("a failed gateway refresh ends the session", async () => {
    const identity = seedNotificationIdentityMemory();
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    mockPrimeError = new Error("paired proxy authorization failed");

    await useAuthStore.getState().refreshSession();

    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
    expect(
      notificationAvatarRuntime.getNotificationIdentitySnapshot(identity),
    ).toBeNull();
  });

  test("a refresh with no selection touches nothing", async () => {
    await useAuthStore.getState().refreshSession();

    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
    expect(getSessionCallCount).toBe(0);
    expect(clearWidgetSnapshotMock).not.toHaveBeenCalled();
  });
});

describe("session cleanup on logout", () => {
  test("logout clears biometric token", async () => {
    await useAuthStore.getState().logout();

    expect(deleteBiometricTokenMock).toHaveBeenCalled();
  });

  test("logout clears user-scoped browser storage", async () => {
    await useAuthStore.getState().logout();

    expect(clearUserScopedStorageMock).toHaveBeenCalled();
  });

  test("logout drops the widget snapshot", async () => {
    const identity = seedNotificationIdentityMemory();
    await useAuthStore.getState().logout();

    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
    expect(
      notificationAvatarRuntime.getNotificationIdentitySnapshot(identity),
    ).toBeNull();
  });

  // The active-id clear must run BEFORE the selection clear in both
  // branches so subscribers never observe a stale assistant id in their
  // first re-render after logout.
  test("gateway logout clears the active id before clearing the selection", async () => {
    mockIsGatewayAuth = true;
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
      await useAuthStore.getState().logout();
    } finally {
      unsubscribe();
    }

    expect(order).toEqual(["reset", "clear:null"]);
  });

  test("gateway logout clears paired proxy authorization", async () => {
    mockIsGatewayAuth = true;
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

    await useAuthStore.getState().logout();

    expect(getSelfHostedIngressUrl()).toBeNull();
  });

  test("non-gateway logout clears the selection slice after the active-id clear", async () => {
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
      await useAuthStore.getState().logout();
    } finally {
      unsubscribe();
    }

    expect(order).toEqual(["reset", "clear:null"]);
  });

  test("explicit cloud-account logout revokes cloud and biometric credentials even in gateway mode", async () => {
    mockIsGatewayAuth = true;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    const revokeSession = mock(async () => {});
    await useAuthStore.getState().logout({ cloudAccount: { revokeSession } });
    expect(revokeSession).toHaveBeenCalledTimes(1);
    expect(logoutMock).not.toHaveBeenCalled();
    expect(deleteBiometricTokenMock).toHaveBeenCalledTimes(1);
  });

  test("default gateway logout retains gateway-only behavior", async () => {
    mockIsGatewayAuth = true;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    await useAuthStore.getState().logout();
    expect(logoutMock).not.toHaveBeenCalled();
  });
});

describe("connectLocalAssistant", () => {
  test("primes the connection BEFORE selecting the assistant", async () => {
    mockIsLocalClient = true;
    // Prime must complete before the selection write becomes observable —
    // the lifecycle's selection subscription republishes the connection
    // synchronously on the write, with whatever token is cached.
    const order: string[] = [];
    primeLocalGatewayConnectionWithRepairMock.mockImplementationOnce(
      async () => {
        order.push("prime");
      },
    );
    setSelectedAssistantMock.mockImplementationOnce(async (id) => {
      order.push(`select:${String(id)}`);
    });

    await connectLocalAssistant("local-a");

    expect(order).toEqual(["prime", "select:local-a"]);
  });

  test("bootstraps the connected local assistant's cloud identity", async () => {
    mockIsLocalClient = true;

    await connectLocalAssistant("local-a");

    expect(bootstrapLocalAssistantCloudIdentityMock).toHaveBeenCalledTimes(1);
    expect(bootstrapLocalAssistantCloudIdentityMock).toHaveBeenCalledWith(
      "local-a",
    );
  });

  test("rethrows the prime failure without selecting or bootstrapping", async () => {
    mockIsLocalClient = true;
    mockPrimeError = new Error("Guardian token not found");

    await expect(connectLocalAssistant("local-a")).rejects.toThrow(
      "Guardian token not found",
    );

    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
  });
});

describe("connectPairedAssistant", () => {
  // The modern connect import: the entry is a canonical custom remote — the
  // contract classifier's paired shape.
  const pairedEntry = {
    assistantId: "paired-a",
    cloud: "custom",
    ipAddress: "gw.example.com",
    port: 443,
  };

  test("primes the host proxy before selecting", async () => {
    mockIsLocalClient = true;
    mockLockfileAssistants = [pairedEntry];
    const order: string[] = [];
    primeLocalGatewayConnectionMock.mockImplementationOnce(async () => {
      order.push("prime");
    });
    setSelectedAssistantMock.mockImplementationOnce(async (id) => {
      order.push(`select:${String(id)}`);
    });

    await connectPairedAssistant("paired-a");

    expect(order).toEqual(["prime", "select:paired-a"]);
  });

  test("uses the plain prime for the paired target: no wake-repair variant", async () => {
    // Wake only runs inside primeLocalGatewayConnectionWithRepair, and it
    // cannot start or repair an assistant on a remote machine, so a paired
    // connect must stay on the plain prime.
    mockIsLocalClient = true;
    mockLockfileAssistants = [pairedEntry];

    await connectPairedAssistant("paired-a");

    expect(primeLocalGatewayConnectionMock).toHaveBeenCalledTimes(1);
    expect(primeLocalGatewayConnectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: "paired-a", cloud: "custom" }),
    );
    expect(primeLocalGatewayConnectionWithRepairMock).not.toHaveBeenCalled();
    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).not.toHaveBeenCalled();
  });

  test("never bootstraps a cloud identity", async () => {
    // The bootstrap registers a LOCAL assistant with the cloud; a paired
    // entry is a client-side pairing record, not an assistant to register.
    mockIsLocalClient = true;
    mockLockfileAssistants = [pairedEntry];

    await connectPairedAssistant("paired-a");

    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
  });

  test("rejects a non-paired id without priming or selecting", async () => {
    mockIsLocalClient = true;
    mockLockfileAssistants = [{ assistantId: "local-a", cloud: "local" }];

    await expect(connectPairedAssistant("local-a")).rejects.toThrow(
      "Not a paired assistant",
    );

    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });

  test("rejects an unknown id", async () => {
    mockIsLocalClient = true;
    mockLockfileAssistants = [pairedEntry];

    await expect(connectPairedAssistant("missing")).rejects.toThrow(
      "Not a paired assistant",
    );

    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
  });

  test("rethrows the prime failure without selecting", async () => {
    mockIsLocalClient = true;
    mockLockfileAssistants = [pairedEntry];
    mockPrimeError = new Error("Guardian token not found");

    await expect(connectPairedAssistant("paired-a")).rejects.toThrow(
      "Guardian token not found",
    );

    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });
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
