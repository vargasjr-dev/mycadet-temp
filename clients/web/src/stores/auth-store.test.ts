import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { cleanup } from "@testing-library/react";

import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";

type MockSessionUser = {
  id?: string;
  username?: string;
  email?: string;
};

let sessionUser: MockSessionUser | null = null;
let getSessionCallCount = 0;
// Transport-failure controls: `getSessionThrows` simulates a fetch
// rejection; `getSessionFailStatus` sets the status of the !sessionUser
// failure result (401 = settled "no session"; 429/502 = non-authoritative).
let getSessionThrows = false;
let getSessionFailStatus: number | undefined = 401;
// When set to an array, each `getSession` call blocks until its release fn
// (pushed here in call order) is invoked, so a test can hold one or more
// probes in flight and settle them in a chosen order.
let getSessionGates: Array<() => void> | null = null;

let mockIsGatewayAuth = false;
let mockIsLocalClient = false;
let mockIsCadetCloudRemote = false;
let mockIsServedGatewayRuntime = false;
// The assistant `getActiveAssistant()` resolves; `undefined` means none selected.
let mockSelectedAssistant:
  | {
      assistantId: string;
      cloud: string;
      runtimeUrl?: string;
    }
  | undefined;
// The entries `getLockfileAssistant(id)` resolves against.
let mockLockfileAssistants: Array<{ assistantId: string; cloud: string }> = [];
let mockCloudAssistants: unknown[] = [];
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
let mockBiometricToken: string | null = null;
const retrieveBiometricTokenMock = mock(async () => mockBiometricToken);

// Controls the cloud-assistant list returned to the rejection-evidence probe
// and spies on the call. Default `listAssistants` to the legacy `[]` shape
// (whose missing `.ok` short-circuits the check) so existing tests are
// unaffected; the reconciliation tests override it to a well-formed result.
let mockListAssistantsResult: unknown = [];
const listAssistantsMock = mock(async () => {
  if (mockListAssistantsError) {
    throw mockListAssistantsError;
  }
  return mockListAssistantsResult;
});
// A thrown error simulates a transport failure on the assistants probe.
let mockListAssistantsError: Error | null = null;
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
import { isLoopbackPublicUrl } from "@mycadet/service-contracts/remote-web-pairing";
const isRemoteGatewayEntryMock = (entry: {
  cloud: Parameters<typeof isLoopbackGatewayCloud>[0];
  runtimeUrl?: string;
}): boolean =>
  isLoopbackGatewayCloud(entry.cloud) &&
  isUsableRuntimeUrl(entry.runtimeUrl) &&
  !isLoopbackPublicUrl(entry.runtimeUrl);

mock.module("@/lib/auth/allauth-client", () => ({
  getSession: async () => {
    getSessionCallCount++;
    if (getSessionGates) {
      await new Promise<void>((resolve) => {
        getSessionGates!.push(resolve);
      });
    }
    if (getSessionThrows) {
      throw new TypeError("Failed to fetch");
    }
    if (!sessionUser) {
      return {
        ok: false,
        status: getSessionFailStatus,
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
  isCadetCloudRemote: () => mockIsCadetCloudRemote,
  isServedGatewayRuntime: () => mockIsServedGatewayRuntime,
  hasGatewayAssistant: () => mockIsGatewayAuth,
  hasPairedGateway: (
    a: { assistantId: string; runtimeUrl?: string } | undefined,
  ) => !!a && !!a.runtimeUrl,
  hasLocalGateway: (
    a: { assistantId: string; runtimeUrl?: string } | undefined,
  ) => !!a && !a.runtimeUrl,
  getCloudAssistants: () => mockCloudAssistants,
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
}));

mock.module("@/lib/local-cloud-identity", () => ({
  bootstrapLocalAssistantCloudIdentity:
    bootstrapLocalAssistantCloudIdentityMock,
  // Logout unregisters push tokens, which resolve a cloud UUID through
  // this module. The stubs exist so the graph can link; auth-store tests
  // do not exercise the resolver.
  resolveLocalAssistantCloudIdentity: async (id: string) => id,
  fetchCloudStatus: async () => null,
  isUuid: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
}));

mock.module("@/lib/cloud-assistant-id", () => ({
  resolveCloudAssistantId: async (id: string) => id,
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
  retrieveBiometricToken: retrieveBiometricTokenMock,
}));

const clearUserScopedStorageMock = mock(() => {});

mock.module("@/lib/auth/session-cleanup", () => ({
  clearUserScopedStorage: clearUserScopedStorageMock,
}));

// The iOS widget snapshot outlives the page, so every session-ending path has
// to drop it. Full module surface: `mock.module` is process-global in bun, so
// a partial shape would shadow the other exports for later test files.
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

// Don't mock `@/lib/event-bus` — bun's `mock.module` is process-
// global, so any stub here shadows the real bus for every later
// test file in the run. `auth-store` only subscribes to `app.resume`
// at module load; the real bus's `subscribe` returns an unsubscribe
// and the registered handler stays inert in tests that don't publish
// `app.resume`.

// `@/assistant/api` transitively pulls in `@mycadet/assistant-api`
// exports that are currently missing on main. Mock the call sites
// `auth-store` actually uses; the real module load would crash
// before any test runs.
mock.module("@/assistant/api", () => ({
  listAssistants: listAssistantsMock,
}));

const { __settleCloudProbeForTesting, useAuthStore, whenCloudSessionProbed } =
  await import("@/stores/auth-store");
const { connectCloudAssistant, connectLocalAssistant, connectPairedAssistant } =
  await import("@/assistant/connect-assistant");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");

beforeEach(() => {
  sessionUser = null;
  getSessionCallCount = 0;
  getSessionThrows = false;
  getSessionFailStatus = 401;
  getSessionGates = null;
  localStorage.removeItem("device:share_diagnostics");
  localStorage.removeItem("device:diagnostics_reporting");
  mockIsGatewayAuth = false;
  mockIsLocalClient = false;
  mockIsCadetCloudRemote = false;
  mockIsServedGatewayRuntime = false;
  mockSelectedAssistant = undefined;
  mockLockfileAssistants = [];
  mockCloudAssistants = [];
  mockIsBiometricEnabled = false;
  mockBiometricToken = null;
  setSelfHostedConnection(null);
  mockPrimeError = null;
  setSelectedAssistantMock.mockClear();
  primeLocalGatewayConnectionMock.mockClear();
  primeLocalGatewayConnectionWithStartupRetryMock.mockClear();
  primeLocalGatewayConnectionWithRepairMock.mockClear();
  clearUserScopedStorageMock.mockClear();
  clearWidgetSnapshotMock.mockClear();
  notificationAvatarRuntime.__clearNotificationIdentitySnapshotsForTests();
  logoutMock.mockClear();
  deleteBiometricTokenMock.mockClear();
  mockListAssistantsResult = [];
  listAssistantsMock.mockClear();
  mockListAssistantsError = null;
  bootstrapLocalAssistantCloudIdentityMock.mockClear();
  // The probe answer is module state; every test starts from the settled
  // "no platform session" default and lets a flow re-settle it.
  __settleCloudProbeForTesting("absent");
  // Reset the resolved-assistants store so each test starts from a known
  // selection state.
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

afterEach(() => {
  cleanup();
});

/** Let every pending microtask and timer-free continuation run. */
function flushTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("auth store plane settles", () => {
  for (const localBuild of [true, false]) {
    test(`served browser init and resume skip cloud auth and settle absent (local build=${localBuild})`, async () => {
      mockIsServedGatewayRuntime = true;
      mockIsLocalClient = localBuild;
      await useAuthStore.getState().initSession();
      await useAuthStore.getState().refreshSession();
      expect(getSessionCallCount).toBe(0);
      expect(
        primeLocalGatewayConnectionWithStartupRetryMock,
      ).not.toHaveBeenCalled();
      expect(await whenCloudSessionProbed()).toBe("absent");
    });
  }

  test("initSession on the public pair page settles absent without pinging anything", async () => {
    mockIsGatewayAuth = true;
    window.history.pushState({}, "", "/assistant/pair");
    try {
      await useAuthStore.getState().initSession();

      // The pair page's session comes from the pairing flow itself: no
      // local prime, no cloud probe.
      expect(
        primeLocalGatewayConnectionWithStartupRetryMock,
      ).not.toHaveBeenCalled();
      expect(getSessionCallCount).toBe(0);
      expect(await whenCloudSessionProbed()).toBe("absent");
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  test("initSession on a served-gateway runtime settles absent without the local prime", async () => {
    mockIsGatewayAuth = true;
    mockIsServedGatewayRuntime = true;

    await useAuthStore.getState().initSession();

    // Cookie custody: the boot claims the session and lets the edge
    // arbitrate per request — the desktop prime machinery (its 90s
    // startup ride-out) is not desktop machinery at all on a remote
    // browser and never runs.
    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).not.toHaveBeenCalled();
    expect(await whenCloudSessionProbed()).toBe("absent");
  });

  test("initSession in cloud-auth mode registers no self-hosted connection and skips the gateway ping", async () => {
    mockIsCadetCloudRemote = true;
    // A cloud-hosted cadet has no self-hosted connection to register — the
    // bundle derives its API base from its own origin.
    setSelfHostedConnection({
      url: "https://stale-from-earlier-session.test",
      token: "tok",
    });

    await useAuthStore.getState().initSession();

    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
    expect(getSessionCallCount).toBe(0);
    // The cloud cookie is the credential: the probe answer is present
    // without a network probe.
    expect(await whenCloudSessionProbed()).toBe("present");
    expect(getSelfHostedIngressUrl()).toBe(
      "https://stale-from-earlier-session.test",
    );
    expect(getSelfHostedActorToken()).toBe("tok");
  });

  test("refreshSession in cloud-auth mode re-verifies the cloud session instead of the gateway", async () => {
    mockIsCadetCloudRemote = true;
    sessionUser = { id: "user-1", email: "user@example.com" };

    await useAuthStore.getState().refreshSession();

    expect(await whenCloudSessionProbed()).toBe("present");
  });

  test("refreshSession in cloud-auth mode settles absent when the cloud probe rejects", async () => {
    mockIsCadetCloudRemote = true;
    // sessionUser stays null, so the getSession probe settles negative.

    await useAuthStore.getState().refreshSession();

    expect(await whenCloudSessionProbed()).toBe("absent");
  });

  test("initSession restores the local gateway session through the startup-retry prime", async () => {
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

  test("initSession still probes the cloud session when the startup-retry prime is exhausted", async () => {
    // After the ride-out budget is spent the prime still throws; the follow-up
    // probe settles the cloud answer — the prime failure does not.
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    mockPrimeError = new Error("Gateway token request failed: 401");
    sessionUser = { id: "user-1", email: "user@example.com" };

    const gates: Array<() => void> = [];
    getSessionGates = gates;

    await useAuthStore.getState().initSession();

    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).toHaveBeenCalledTimes(1);
    // The probe is in flight: the answer is not settled by the boot itself.
    let settled = false;
    void whenCloudSessionProbed().then(() => {
      settled = true;
    });
    await flushTasks();
    expect(settled).toBe(false);

    gates[0]?.();
    await flushTasks();
    expect(await whenCloudSessionProbed()).toBe("present");
  });

  test("refreshSession still runs the rejection-evidence probe in local mode", async () => {
    // Regression: a session refresh (app resume, profile save, provider
    // callback) re-checks the assistants API for a settled rejection — not
    // only cold `initSession`.
    mockIsLocalClient = true;
    sessionUser = { id: "user-3", email: "user@example.com" };
    mockListAssistantsResult = {
      ok: true,
      status: 200,
      data: [
        {
          id: "assistant-3",
          name: "My Assistant",
          is_local: false,
          created: "2026-06-05T00:00:00Z",
        },
      ],
    };

    await useAuthStore.getState().refreshSession();

    expect(listAssistantsMock).toHaveBeenCalled();
    expect(await whenCloudSessionProbed()).toBe("present");
  });

  test("logout does not clear consent flags (durable device keys survive)", async () => {
    await useAuthStore.getState().logout();
    expect(await whenCloudSessionProbed()).toBe("absent");
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
});

/**
 * Hold the next `clearWidgetSnapshot()` open, returning the release fn, so a
 * test can interleave work with a session-ending path suspended on the bridge.
 */
function holdWidgetSnapshotClear(): () => void {
  let release = (): void => {};
  clearWidgetSnapshotMock.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      }),
  );
  return () => release();
}

// A Home Screen widget is readable without unlocking the device, so the iOS
// widget snapshot must not outlive the session it was built from. Explicit
// logout is the rare way a session ends; a revoked or expired one settles
// through `refreshSession` or `initSession` instead, so the drop belongs to
// the shared session-ended teardown rather than to `logout()`.
describe("iOS widget snapshot on session end", () => {
  test("logout drops the widget snapshot", async () => {
    const identity = seedNotificationIdentityMemory();
    await useAuthStore.getState().logout();

    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
    expect(
      notificationAvatarRuntime.getNotificationIdentitySnapshot(identity),
    ).toBeNull();
  });

  test("gateway logout drops the widget snapshot", async () => {
    mockIsGatewayAuth = true;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });

    await useAuthStore.getState().logout();

    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
  });

  test("a failed remote-gateway refresh drops the widget snapshot", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    mockPrimeError = new Error("paired proxy authorization failed");

    await useAuthStore.getState().refreshSession();

    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
    expect(await whenCloudSessionProbed()).toBe("absent");
  });

  test("an exhausted gateway prime drops the widget snapshot", async () => {
    // Boot ends the session teardown after the startup-retry budget is
    // spent, so the previous session's titles must not survive on the Home
    // Screen while the app shows the recovery controls.
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    mockPrimeError = new Error("Gateway token request failed: 401");

    await useAuthStore.getState().initSession();

    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
  });

  test("an inconclusive probe keeps the widget snapshot", async () => {
    // Offline resume (LUM-2412): the session never ended, so blanking the
    // widgets would be a regression, not a cleanup.
    getSessionThrows = true;
    mockIsLocalClient = false;

    await useAuthStore.getState().refreshSession();

    expect(clearWidgetSnapshotMock).not.toHaveBeenCalled();
  });

  test("a local session that survives a settled 401 keeps the widget snapshot", async () => {
    // A local client's session stands on its own: the 401 retracts the
    // platform answer without running the session-ended teardown.
    mockIsLocalClient = true;
    sessionUser = null;

    await useAuthStore.getState().refreshSession();

    expect(await whenCloudSessionProbed()).toBe("absent");
    expect(clearWidgetSnapshotMock).not.toHaveBeenCalled();
  });

  test("an explicit logout outlasts a refresh that authenticates during the clear", async () => {
    // Logout has already dropped the credentials, the selection and the
    // user-scoped storage before it reaches the clear, so a refresh that
    // lands inside that window is describing a session that no longer
    // exists. Deferring to it would bootstrap the departing account's
    // identity after the press.
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    const releaseClear = holdWidgetSnapshotClear();

    const loggingOut = useAuthStore.getState().logout();
    await flushTasks();

    // The app-resume listener explicitly permits overlapping refreshes.
    await useAuthStore.getState().refreshSession();

    releaseClear();
    await loggingOut;

    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
    expect(await whenCloudSessionProbed()).toBe("absent");
  });

  test("a gateway re-auth during the snapshot clear still probes the retry's session", async () => {
    // A boot that exhausted its gateway prime must not log out the session a
    // retry established while the boot's snapshot clear was still
    // outstanding: the teardowns are idempotent clears, and the follow-up
    // probe decides the answer.
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    mockPrimeError = new Error("Gateway token request failed: 401");
    const releaseClear = holdWidgetSnapshotClear();

    const booting = useAuthStore.getState().initSession();
    await flushTasks();

    mockPrimeError = null;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    sessionUser = { id: "user-1", email: "user@example.com" };
    // The re-auth is a gateway session: give the refresh a paired selection
    // whose resolvable gateway re-verifies through the prime.
    mockSelectedAssistant = {
      assistantId: "paired-1",
      cloud: "local",
      runtimeUrl: "https://gw.example.com",
    };
    await useAuthStore.getState().refreshSession();

    releaseClear();
    await booting;

    expect(await whenCloudSessionProbed()).toBe("present");
  });
});

/**
 * Hold the next assistants probe open, returning the release fn, so a test
 * can suspend a refresh mid-flight between the session response and the
 * settle that response drives.
 */
function holdAssistantsFetch(): () => void {
  let release = (): void => {};
  listAssistantsMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(mockListAssistantsResult);
      }),
  );
  return () => release();
}

// The observation-vs-decision rule: a logout invalidates the observations
// already in flight. A refresh that fetched its session while the credentials
// were still valid can still be inside its awaits when logout ends the
// session, and settling the answer from that response would re-stamp a
// session the user just ended.
describe("explicit logout supersedes an in-flight refresh", () => {
  test("a refresh that began before logout abandons its settle", async () => {
    // A LOCAL client: the refresh's reconcile sync is the path's longest
    // await, so holdAssistantsFetch can actually suspend it between the
    // session response and the settle.
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    const releaseAssistants = holdAssistantsFetch();

    const refreshing = useAuthStore.getState().refreshSession();
    await flushTasks();

    await useAuthStore.getState().logout();

    releaseAssistants();
    await refreshing;

    // The logout's own settle stands: the superseded observation never lands.
    expect(await whenCloudSessionProbed()).toBe("absent");
    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
  });

  test("a refresh that starts midway through a logout is superseded too", async () => {
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    const releaseClear = holdWidgetSnapshotClear();

    const loggingOut = useAuthStore.getState().logout();
    await flushTasks();

    // Enters while logout is suspended on the snapshot clear, and resumes only
    // after logout's session-ending teardown has landed.
    const releaseAssistants = holdAssistantsFetch();
    const refreshing = useAuthStore.getState().refreshSession();
    await flushTasks();

    releaseClear();
    await loggingOut;
    releaseAssistants();
    await refreshing;

    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
    expect(await whenCloudSessionProbed()).toBe("absent");
  });

  test("a refresh that completes with no logout still settles present", async () => {
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    const releaseAssistants = holdAssistantsFetch();

    const refreshing = useAuthStore.getState().refreshSession();
    await flushTasks();
    releaseAssistants();

    await refreshing;
    expect(await whenCloudSessionProbed()).toBe("present");
  });

  test("a sign-in started after a logout is never blocked", async () => {
    // The generation is snapshotted on entry, so a completed logout can only
    // supersede refreshes that were already running. Nothing resets it, and a
    // fresh sign-in still commits.
    mockIsLocalClient = true;
    mockCloudAssistants = [];
    sessionUser = { id: "user-1", email: "user@example.com" };

    await useAuthStore.getState().logout();

    // The provider callback and signup pages commit an interactive sign-in
    // through `refreshSession`.
    sessionUser = { id: "user-2", email: "user2@example.com" };
    await useAuthStore.getState().refreshSession();
    expect(await whenCloudSessionProbed()).toBe("present");

    // And the connect action commits one directly.
    await useAuthStore.getState().logout();
    __settleCloudProbeForTesting("absent");
    await connectCloudAssistant("assistant-1");
    expect(await whenCloudSessionProbed()).toBe("present");
  });
});

describe("platform session probe resolution", () => {
  // Two probes can overlap — an app-resume refresh firing while the initial
  // probe is still in flight. Awaiters chase the newest probe: an older
  // probe's settle must not answer for it.
  test("an awaiter of an in-flight re-probe waits for the fresh answer", async () => {
    mockIsGatewayAuth = true;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };

    const gates: Array<() => void> = [];
    getSessionGates = gates;

    await useAuthStore.getState().refreshSession();

    // Probe launched but not settled: an awaiter does not get a stale answer.
    let settled = false;
    void whenCloudSessionProbed().then(() => {
      settled = true;
    });
    await flushTasks();
    expect(settled).toBe(false);

    gates[0]();
    await flushTasks();

    expect(await whenCloudSessionProbed()).toBe("present");
  });

  test("a stale probe completing after a newer one does not answer the chase", async () => {
    mockIsGatewayAuth = true;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };

    const gates: Array<() => void> = [];
    getSessionGates = gates;

    // Launch two overlapping probes; neither has settled.
    await useAuthStore.getState().refreshSession();
    await useAuthStore.getState().refreshSession();
    expect(gates.length).toBe(2);

    // Settle the older probe first: it is stale, so the chase keeps waiting.
    gates[0]();
    await flushTasks();
    let settled = false;
    void whenCloudSessionProbed().then(() => {
      settled = true;
    });
    await flushTasks();
    expect(settled).toBe(false);

    // The newest probe settling is what answers.
    gates[1]();
    await flushTasks();
    expect(await whenCloudSessionProbed()).toBe("present");
  });
});

describe("platform probe conclusive rejection (half-dead session)", () => {
  // The half-dead state: allauth answers 200 with a user while the cloud
  // API conclusively rejects the same credential. The probe consumes the
  // assistants-list evidence it already gathers and settles "absent".
  //
  // Every test drives the local-client init path (no gateway machinery),
  // where the probe runs and bootstraps identity on success.
  function arrangeLocalProbe(): void {
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
  }

  test("an assistants-list session rejection settles the answer absent", async () => {
    arrangeLocalProbe();
    mockListAssistantsResult = { ok: false, status: 403, error: {} };

    await useAuthStore.getState().initSession();

    expect(await whenCloudSessionProbed()).toBe("absent");
    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
  });

  test("a transport-thrown assistants probe keeps the present settle", async () => {
    arrangeLocalProbe();
    mockListAssistantsError = new TypeError("Failed to fetch");

    await useAuthStore.getState().initSession();

    // No evidence of rejection: the offline-restore contract (LUM-2412)
    // keeps the session present.
    expect(await whenCloudSessionProbed()).toBe("present");
    expect(bootstrapLocalAssistantCloudIdentityMock).toHaveBeenCalled();
  });

  test("a non-rejection assistants failure keeps the present settle", async () => {
    arrangeLocalProbe();
    mockListAssistantsResult = { ok: false, status: 503, error: {} };

    await useAuthStore.getState().initSession();

    expect(await whenCloudSessionProbed()).toBe("present");
  });

  test("the probe clears its sync race timer once it settles", async () => {
    arrangeLocalProbe();
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");

    try {
      await useAuthStore.getState().initSession();
      await whenCloudSessionProbed();

      const raceTimerIndex = setTimeoutSpy.mock.calls.findIndex(
        (call) => call[1] === 3_000,
      );
      expect(raceTimerIndex).toBeGreaterThanOrEqual(0);
      const raceTimerHandle = setTimeoutSpy.mock.results[raceTimerIndex]?.value;
      expect(
        clearTimeoutSpy.mock.calls.some((call) => call[0] === raceTimerHandle),
      ).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});

describe("session-rejection evidence at sibling confirmation sites", () => {
  // The same half-dead evidence rule applies wherever an allauth 200 would
  // otherwise confirm the session: refreshSession's resume path and
  // initSession's local path.

  test("refreshSession settles absent on an assistants-list rejection", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockListAssistantsResult = { ok: false, status: 401, error: {} };

    await useAuthStore.getState().refreshSession();

    expect(await whenCloudSessionProbed()).toBe("absent");
  });

  test("a resume refresh does not flip a probe-settled absent session back to present", async () => {
    // Pin the oscillation regression: the probe settles absent on rejection,
    // then the app-resume refresh runs against the same half-dead session.
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockListAssistantsResult = { ok: false, status: 403, error: {} };

    await useAuthStore.getState().initSession();
    expect(await whenCloudSessionProbed()).toBe("absent");

    await useAuthStore.getState().refreshSession();

    expect(await whenCloudSessionProbed()).toBe("absent");
  });

  test("a transport-failed assistants probe on refresh keeps the cloud confirmation", async () => {
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockListAssistantsError = new TypeError("Failed to fetch");

    await useAuthStore.getState().refreshSession();

    expect(await whenCloudSessionProbed()).toBe("present");
  });

  test("a non-rejection assistants failure on refresh keeps the cloud confirmation", async () => {
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockListAssistantsResult = { ok: false, status: 503, error: {} };

    await useAuthStore.getState().refreshSession();

    expect(await whenCloudSessionProbed()).toBe("present");
  });

  test("initSession settles a rejected platform session absent (never login)", async () => {
    // Web holds no platform roster to gate the probe on, so the plain local
    // arm always probes; a settled rejection settles the answer absent.
    // Login routing is the app shell's decision.
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockListAssistantsResult = { ok: false, status: 403, error: {} };

    await useAuthStore.getState().initSession();

    expect(await whenCloudSessionProbed()).toBe("absent");
    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
  });

  test("initSession settles an assistants-list rejection absent", async () => {
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockListAssistantsResult = { ok: false, status: 410, error: {} };

    await useAuthStore.getState().initSession();

    expect(await whenCloudSessionProbed()).toBe("absent");
  });

  test("initSession keeps the adopted platform session on a transport-failed probe", async () => {
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockListAssistantsError = new TypeError("Failed to fetch");

    await useAuthStore.getState().initSession();

    expect(await whenCloudSessionProbed()).toBe("present");
  });
});

describe("connectLocalAssistant", () => {
  test("primes the connection BEFORE selecting the assistant", async () => {
    mockIsLocalClient = true;
    mockCloudAssistants = [];
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
    // No platform assistants — nothing to probe, so the answer settles
    // directly to "absent" rather than awaiting a probe.
    expect(await whenCloudSessionProbed()).toBe("absent");
  });

  test("waits for the new cloud probe before bootstrapping a connected local assistant", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    sessionUser = { id: "user-1" };
    __settleCloudProbeForTesting("present");
    getSessionGates = [];

    await connectLocalAssistant("local-a");

    // A cached present answer is insufficient: the fresh probe must confirm it.
    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
    expect(getSessionGates).toHaveLength(1);
    getSessionGates[0]!();

    expect(await whenCloudSessionProbed()).toBe("present");
    expect(bootstrapLocalAssistantCloudIdentityMock).toHaveBeenCalledTimes(1);
  });

  test("does not bootstrap from cached cloud state when the fresh probe rejects it", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    sessionUser = null;
    __settleCloudProbeForTesting("present");

    await connectLocalAssistant("local-a");

    expect(await whenCloudSessionProbed()).toBe("absent");
    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
  });

  test("rethrows the prime failure without selecting", async () => {
    mockIsLocalClient = true;
    mockPrimeError = new Error("Guardian token not found");

    await expect(connectLocalAssistant("local-a")).rejects.toThrow(
      "Guardian token not found",
    );

    // A failed connect leaves the previous selection in place.
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });
});

describe("connectPairedAssistant", () => {
  // The modern connect import: cloud reads local; the off-machine runtimeUrl
  // is what makes it a paired target.
  const pairedEntry = {
    assistantId: "paired-a",
    cloud: "local",
    runtimeUrl: "https://gw.example.com",
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
      expect.objectContaining({ assistantId: "paired-a", cloud: "local" }),
    );
    expect(primeLocalGatewayConnectionWithRepairMock).not.toHaveBeenCalled();
    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).not.toHaveBeenCalled();
  });

  test("never bootstraps a cloud identity, even with a live platform session", async () => {
    // The bootstrap registers a LOCAL assistant with the cloud; a paired
    // entry is a client-side pairing record, not an assistant to register.
    mockIsLocalClient = true;
    mockLockfileAssistants = [pairedEntry];
    __settleCloudProbeForTesting("present");

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

describe("paired selection in the gateway-auth session paths", () => {
  const pairedSelection = {
    assistantId: "paired-a",
    cloud: "local",
    runtimeUrl: "https://gw.example.com",
  };

  test("refreshSession re-primes a paired selection and never fetches the SPA origin's /auth/token", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockSelectedAssistant = pairedSelection;
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

  test("refreshSession settles absent when paired proxy authorization fails", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockSelectedAssistant = pairedSelection;
    mockPrimeError = new Error("paired proxy authorization failed");

    await useAuthStore.getState().refreshSession();

    expect(await whenCloudSessionProbed()).toBe("absent");
  });

  test("refreshSession rotates a local selection's gateway JWT through the prime", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };

    await useAuthStore.getState().refreshSession();

    // The gateway-JWT rotation covers the refresh — no re-mint.
    expect(primeLocalGatewayConnectionMock).toHaveBeenCalledTimes(1);
  });

  test("boot with a paired proxy authorization failure settles absent after one prime", async () => {
    // Paired failures are not ridden out (the budget pin lives in
    // local-mode.test.ts, "a failing paired credential read is not ridden out").
    // Here: the boot path routes the paired selection through the generalized
    // prime once and falls through promptly to the chooser.
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockSelectedAssistant = pairedSelection;
    mockPrimeError = new Error("paired proxy authorization failed");

    await useAuthStore.getState().initSession();

    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).toHaveBeenCalledTimes(1);
    expect(await whenCloudSessionProbed()).toBe("absent");
  });
});

// The store carries no user and no session state — the identity surface is
// the probe answer: a platform account ⟺ "present", local gateway access ⟺
// "absent" with the gateway primed.
describe("session shape (platform vs local gateway access)", () => {
  test("a local gateway session answers absent from the follow-up probe", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    mockCloudAssistants = [];
    sessionUser = null;

    await useAuthStore.getState().initSession();

    expect(await whenCloudSessionProbed()).toBe("absent");
  });

  test("a cloud-remote session answers present", async () => {
    mockIsCadetCloudRemote = true;
    sessionUser = { id: "user-1", email: "user@example.com" };

    await useAuthStore.getState().initSession();

    expect(await whenCloudSessionProbed()).toBe("present");
  });
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
  expect(await whenCloudSessionProbed()).toBe("absent");
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
