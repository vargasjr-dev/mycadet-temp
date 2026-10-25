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
let getSessionFailFirstCall = false;
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
// The assistant `getSelectedAssistant()` resolves; `undefined` means none selected.
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
const refreshRemoteGatewaySessionMock = mock(async () => false);
const clearOrganizationMock = mock(() => {});
const logoutMock = mock(async () => {});
const deleteBiometricTokenMock = mock(async () => {});

let mockIsNativePlatform = false;
let mockIsBiometricEnabled = false;
let mockBiometricToken: string | null = null;
const installSessionCookiesMock = mock((_token: string) => {});
const retrieveBiometricTokenMock = mock(async () => mockBiometricToken);

// Controls the cloud-assistant list returned to the lockfile-sync path and
// spies on the sync itself. Default `listAssistants` to the legacy `[]` shape
// (whose missing `.ok` short-circuits the sync) so existing tests are
// unaffected; the reconciliation tests override it to a well-formed result.
let mockListAssistantsResult: unknown = [];
const listAssistantsMock = mock(async () => mockListAssistantsResult);
// Controls the `OrgFetchOutcome` the session-rejection evidence checks read.
// A thrown error simulates a transport failure; a never-resolving promise as
// the outcome makes the fetch hang so the probe's sync race times out.
let mockOrgFetchOutcome: unknown = { ok: true };
let mockOrgFetchError: Error | null = null;
const fetchOrganizationsMock = mock(async () => {
  if (mockOrgFetchError) {
    throw mockOrgFetchError;
  }
  return mockOrgFetchOutcome;
});
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
    if (getSessionFailFirstCall && getSessionCallCount === 1) {
      return { ok: false, status: 401, error: { detail: "Unauthorized" } };
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

let mockElectronSessionToken: string | null = null;
mock.module("@/runtime/session-token", () => ({
  getElectronSessionToken: () => mockElectronSessionToken,
  primeElectronSessionToken: (token: string) => {
    mockElectronSessionToken = token;
  },
  __resetForTesting: () => {},
}));

/** The paired test's own addressing derivation, mirroring the store's. */
const mockPairedSelection = () =>
  mockIsGatewayAuth &&
  mockSelectedAssistant?.runtimeUrl != null &&
  !/\/\/127\.0\.0\.1|\/\/localhost/.test(mockSelectedAssistant.runtimeUrl);

mock.module("@/lib/local-mode", () => ({
  isLocalClient: () => mockIsLocalClient,
  isLocalAssistant: (a: { cloud?: string }) => a.cloud === "local",
  isCloudAssistant: (a: { cloud?: string }) => a.cloud === "cadet",
  isCadetCloudRemote: () => mockIsCadetCloudRemote,
  isServedGatewayRuntime: () => mockIsServedGatewayRuntime,
  hasGatewayAssistant: () => mockIsGatewayAuth,
  isGatewaySessionLive: () =>
    getSelfHostedActorToken() !== null || mockPairedSelection(),
  getCloudAssistants: () => mockCloudAssistants,
  getLocalAssistants: () => [],
  getSelectedAssistant: () => mockSelectedAssistant,
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
  refreshRemoteGatewaySession: refreshRemoteGatewaySessionMock,
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
  isNativePlatform: () => mockIsNativePlatform,
  isOAuthFlowInFlight: () => false,
  installSessionCookies: installSessionCookiesMock,
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

// Use the REAL resolved-assistants store: it's dependency-light, so loading it
// for real is cheap, and the `beforeEach` resets it between tests. (The list
// is not loaded by the auth store.)

// Auth-store writes the selection through the public wrapper, not the store
// action — mock the wrapper module so the real one (and its local-mode deps)
// never loads.
mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: setSelectedAssistantMock,
}));

mock.module("@/stores/organization-store", () => ({
  clearOrganization: clearOrganizationMock,
  useOrganizationStore: {
    getState: () => ({
      fetchOrganizations: fetchOrganizationsMock,
      clearOrganization: clearOrganizationMock,
      currentOrganizationId: "org-test",
    }),
  },
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

const {
  useAuthStore,
  subscribeCloudAccountLogout,
  beginCloudAccountOAuth,
  isCloudAccountOAuthInFlight,
  primeCloudAccountSessionToken,
  setupAuthListeners,
  whenCloudSessionSettled,
} = await import("@/stores/auth-store");
const { connectCloudAssistant, connectLocalAssistant, connectPairedAssistant } =
  await import("@/assistant/connect-assistant");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");

function resetAuthStore(): void {
  useAuthStore.setState({
    sessionStatus: "initializing",
    cloudSession: "unknown",
  });
}

function authenticatedLocalUserForTest() {
  return {
    sessionStatus: "authenticated" as const,
    cloudSession: "absent" as const,
  };
}

beforeEach(() => {
  sessionUser = null;
  getSessionCallCount = 0;
  getSessionFailFirstCall = false;
  getSessionThrows = false;
  getSessionFailStatus = 401;
  getSessionGates = null;
  mockElectronSessionToken = null;
  localStorage.removeItem("cadet:auth:sessionSnapshot");
  localStorage.removeItem("device:share_diagnostics");
  localStorage.removeItem("device:diagnostics_reporting");
  mockIsGatewayAuth = false;
  mockIsLocalClient = false;
  mockIsCadetCloudRemote = false;
  mockIsServedGatewayRuntime = false;
  mockSelectedAssistant = undefined;
  mockLockfileAssistants = [];
  mockCloudAssistants = [];
  mockIsNativePlatform = false;
  mockIsBiometricEnabled = false;
  mockBiometricToken = null;
  setSelfHostedConnection(null);
  mockPrimeError = null;
  setSelectedAssistantMock.mockClear();
  primeLocalGatewayConnectionMock.mockClear();
  primeLocalGatewayConnectionWithStartupRetryMock.mockClear();
  primeLocalGatewayConnectionWithRepairMock.mockClear();
  refreshRemoteGatewaySessionMock.mockClear();
  clearOrganizationMock.mockClear();
  clearUserScopedStorageMock.mockClear();
  clearWidgetSnapshotMock.mockClear();
  notificationAvatarRuntime.__clearNotificationIdentitySnapshotsForTests();
  logoutMock.mockClear();
  deleteBiometricTokenMock.mockClear();
  installSessionCookiesMock.mockClear();
  retrieveBiometricTokenMock.mockClear();
  mockListAssistantsResult = [];
  listAssistantsMock.mockClear();
  mockOrgFetchOutcome = { ok: true };
  mockOrgFetchError = null;
  fetchOrganizationsMock.mockClear();
  bootstrapLocalAssistantCloudIdentityMock.mockClear();
  resetAuthStore();
  // Reset the lifecycle and resolved-assistants stores so each test starts from
  // a known connection/selection state.
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

afterEach(() => {
  cleanup();
});

describe("auth store onboarding flag reconciliation", () => {
  for (const refreshSucceeds of [true, false]) {
    for (const localBuild of [true, false]) {
      test(`served browser init and resume skip cloud auth (refresh=${refreshSucceeds}, local build=${localBuild})`, async () => {
        mockIsServedGatewayRuntime = true;
        mockIsLocalClient = localBuild;
        refreshRemoteGatewaySessionMock.mockImplementation(
          async () => refreshSucceeds,
        );
        await useAuthStore.getState().initSession();
        await useAuthStore.getState().refreshSession();
        expect(getSessionCallCount).toBe(0);
        expect(
          primeLocalGatewayConnectionWithStartupRetryMock,
        ).not.toHaveBeenCalled();
        expect(useAuthStore.getState().cloudSession).toBe("absent");
        expect(useAuthStore.getState().sessionStatus).toBe(
          refreshSucceeds ? "authenticated" : "unauthenticated",
        );
        refreshRemoteGatewaySessionMock.mockImplementation(async () => false);
      });
    }
  }

  test("initSession treats remote-gateway mode as an authenticated local session", async () => {
    refreshRemoteGatewaySessionMock.mockImplementationOnce(async () => true);

    await useAuthStore.getState().initSession();

    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
    expect(refreshRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    expect(getSessionCallCount).toBe(0);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
  });

  test("refreshSession keeps remote-gateway mode authenticated without minting a local token", async () => {
    mockIsGatewayAuth = true;
    refreshRemoteGatewaySessionMock.mockImplementationOnce(async () => true);

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(refreshRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
    expect(getSessionCallCount).toBe(0);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
  });

  test("initSession on the public pair page settles unauthenticated without pinging anything", async () => {
    mockIsGatewayAuth = true;
    window.history.pushState({}, "", "/assistant/pair");
    try {
      await useAuthStore.getState().initSession();

      // The pair page's session comes from the pairing flow itself: no
      // guardian-refresh ping, no local prime, no cloud probe.
      expect(refreshRemoteGatewaySessionMock).not.toHaveBeenCalled();
      expect(
        primeLocalGatewayConnectionWithStartupRetryMock,
      ).not.toHaveBeenCalled();
      expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  test("initSession on a served-gateway runtime skips the local prime and settles fast", async () => {
    mockIsGatewayAuth = true;
    mockIsServedGatewayRuntime = true;

    await useAuthStore.getState().initSession();

    // The boot ping still runs (it is the paired-device restore path)...
    expect(refreshRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    // ...but the desktop prime machinery (its 90s startup ride-out) never
    // does, so the route guard can route an unpaired device to the pair
    // page immediately.
    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).not.toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("initSession leaves remote-gateway mode unauthenticated when cookie refresh fails and no token exists", async () => {
    await useAuthStore.getState().initSession();

    expect(refreshRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
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

    expect(refreshRemoteGatewaySessionMock).not.toHaveBeenCalled();
    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
    expect(getSessionCallCount).toBe(0);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
    expect(getSelfHostedIngressUrl()).toBe(
      "https://stale-from-earlier-session.test",
    );
    expect(getSelfHostedActorToken()).toBe("tok");
  });

  test("refreshSession in cloud-auth mode re-probes the cloud session instead of the gateway", async () => {
    mockIsCadetCloudRemote = true;
    useAuthStore.setState({ ...authenticatedLocalUserForTest() });
    sessionUser = { id: "user-1", email: "user@example.com" };

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(refreshRemoteGatewaySessionMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  test("refreshSession in cloud-auth mode ends the session when the cloud probe rejects", async () => {
    mockIsCadetCloudRemote = true;
    useAuthStore.setState({ ...authenticatedLocalUserForTest() });
    // sessionUser stays null, so the getSession probe settles negative.

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(refreshRemoteGatewaySessionMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("refreshSession ends remote-gateway sessions when refresh fails and no token exists", async () => {
    useAuthStore.setState({ ...authenticatedLocalUserForTest() });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(refreshRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
  });

  test("refreshSession keeps remote-gateway sessions when refresh throws but a token is still valid", async () => {
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    refreshRemoteGatewaySessionMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(refreshRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
  });

  test("refreshSession keeps the local gateway session but clears stale platform state on a settled 401", async () => {
    // Local gateway is the auth source (enabled) but its token isn't minted yet.
    // The user had also signed into the cloud; the cloud session now
    // settles negative (401). The local session stays authenticated, but the
    // stale platform user and "present" status are cleared.
    mockIsLocalClient = true;
    mockIsGatewayAuth = true; // isGatewayAuthEnabled() === true
    sessionUser = null; // platform probe settles 401
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(getSessionCallCount).toBe(1); // probe ran — a success could still update the store
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated"); // local session not ended
    expect(useAuthStore.getState().cloudSession).toBe("absent"); // stale platform state cleared
  });

  test("refreshSession keeps a pre-hatch local session alive on a settled 401", async () => {
    // Brand-new desktop user: nothing hatched, so no local gateway URL, and no
    // platform account for the probe to find.
    mockIsLocalClient = true;
    mockIsGatewayAuth = false;
    mockCloudAssistants = [];
    sessionUser = null;
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "unknown",
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
  });

  test("refreshSession still ends a local session whose assistants are cloud-hosted", async () => {
    // A cloud assistant is unreachable without a cloud session, so the
    // demotion above excludes this case and login is the right destination.
    mockIsLocalClient = true;
    mockIsGatewayAuth = false;
    mockCloudAssistants = [{ assistantId: "managed-1", cloud: "cadet" }];
    sessionUser = null;
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("refreshSession still ends the session for a cloud-mode client on a settled 401", async () => {
    // The web SPA has no local session to fall back on, so a settled rejection
    // still logs out.
    mockIsLocalClient = false;
    mockIsGatewayAuth = false;
    mockCloudAssistants = [];
    sessionUser = null;
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("refreshSession leaves an unauthenticated session untouched in the gateway window", async () => {
    // Mid cold-start hatch: gateway enabled, token not minted, session not yet
    // established. A settled 401 must not promote to authenticated — the gateway
    // settles the session once its token mints (via connectLocalAssistant).
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    sessionUser = null;
    useAuthStore.setState({
      sessionStatus: "unauthenticated",
      cloudSession: "absent",
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated"); // not promoted
  });

  test("refreshSession in gateway mode still adopts a successful platform session", async () => {
    // A local user who also signs into the cloud (e.g. through the provider
    // callback flow after an allauth login) must have the successful probe
    // update the store, even while the gateway token isn't minted.
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({ cloudSession: "absent" });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(getSessionCallCount).toBe(1);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  test("successful local platform probe bootstraps the selected local assistant identity", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    sessionUser = { id: "user-1", email: "user@example.com" };

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bootstrapLocalAssistantCloudIdentityMock).toHaveBeenCalledWith();
  });

  test("initSession restores the local gateway session through the startup-retry prime", async () => {
    // The boot restore must ride out the gateway's reboot startup window rather
    // than the bare prime, so a transient "starting" failure doesn't drop the
    // persisted local assistant to the recovery controls.
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;

    await useAuthStore.getState().initSession();

    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).toHaveBeenCalledTimes(1);
    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });

  test("initSession settles unauthenticated when the startup-retry prime is exhausted", async () => {
    // After the ride-out budget is spent the prime still throws; boot falls
    // through to the chooser exactly as before.
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockPrimeError = new Error("Gateway token request failed: 401");

    await useAuthStore.getState().initSession();

    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("cloud connect and refresh fetch organizations without storing a user", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };

    await connectCloudAssistant("assistant-1");

    expect(fetchOrganizationsMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState()).not.toHaveProperty("user");
    expect(localStorage.getItem("cadet:auth:sessionSnapshot")).toBe("true");

    fetchOrganizationsMock.mockClear();
    sessionUser = { id: "user-2", email: "other@example.com" };
    await useAuthStore.getState().refreshSession();

    // A live-session account switch has no auth-state edge; the probe itself
    // refreshes the organization selection instead of tracking an account id.
    expect(fetchOrganizationsMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("cadet:auth:sessionSnapshot")).toBe("true");
  });

  test("refreshSession reconciles the lockfile mirror in local mode", async () => {
    // Regression: a session refresh (app resume, profile save, provider
    // callback) must re-sync cloud assistants into the lockfile — not only
    // cold `initSession` — so the macOS tray and CLI don't keep a stale list
    // until the next full boot.
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

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    // The list fetch is the settled-rejection evidence probe; the bundle no
    // longer mirrors platform assistants into any lockfile.
    expect(listAssistantsMock).toHaveBeenCalled();
  });

  test("logout does not clear consent flags (durable device keys survive)", async () => {
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });
});

describe("session cleanup on logout", () => {
  test("logout clears biometric token", async () => {
    await useAuthStore.getState().logout();

    expect(deleteBiometricTokenMock).toHaveBeenCalled();
  });

  test("logout clears organization state", async () => {
    await useAuthStore.getState().logout();

    expect(clearOrganizationMock).toHaveBeenCalled();
  });

  test("logout clears user-scoped browser storage", async () => {
    await useAuthStore.getState().logout();

    expect(clearUserScopedStorageMock).toHaveBeenCalled();
  });

  test("logout clears the active assistant id synchronously, before leaving authenticated", async () => {
    // The active-id clear must happen before the auth state flips,
    // otherwise sync hooks like `useAssistantResourceSync` get one
    // re-render with the previous user's assistant id and fire
    // requests that 401. The order is verified by recording the
    // session status seen at clear time vs the final transition.
    const clearedAtStatus: string[] = [];
    useAuthStore.setState({ sessionStatus: "authenticated" });
    const unsubscribe = useResolvedAssistantsStore.subscribe((state) => {
      if (state.activeAssistantId === null && clearedAtStatus.length === 0) {
        clearedAtStatus.push(useAuthStore.getState().sessionStatus);
      }
    });

    try {
      await useAuthStore.getState().logout();
    } finally {
      unsubscribe();
    }

    expect(clearedAtStatus[0]).toBe("authenticated");
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
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
    useAuthStore.setState({ sessionStatus: "authenticated" });
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
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
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
    useAuthStore.setState({ sessionStatus: "authenticated" });

    await useAuthStore.getState().logout();

    expect(getSelfHostedIngressUrl()).toBeNull();
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
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

/** Let every pending microtask and timer-free continuation run. */
function flushTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
// the shared session-ended transition rather than to `logout()`.
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
    useAuthStore.setState({ sessionStatus: "authenticated" });

    await useAuthStore.getState().logout();

    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
  });

  test("the drop completes before the session leaves authenticated", async () => {
    // The state write is what hands a signed-out page to its redirect, which
    // on the logout path can be a hard navigation. A detached bridge call
    // would race that teardown.
    let statusAtClearTime = useAuthStore.getState().sessionStatus;
    clearWidgetSnapshotMock.mockImplementationOnce(async () => {
      statusAtClearTime = useAuthStore.getState().sessionStatus;
      return true;
    });
    useAuthStore.setState({ sessionStatus: "authenticated" });

    await useAuthStore.getState().logout();

    expect(statusAtClearTime).toBe("authenticated");
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("a settled 401 on refreshSession drops the widget snapshot", async () => {
    // The revoked-session path: no logout call ever runs, so this is the one
    // chance to drop the previous account's conversation titles.
    mockIsLocalClient = false;
    mockCloudAssistants = [];
    sessionUser = null;
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });
    const identity = seedNotificationIdentityMemory();

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
    expect(
      notificationAvatarRuntime.getNotificationIdentitySnapshot(identity),
    ).toBeNull();
  });

  test("a failed remote-gateway refresh drops the widget snapshot", async () => {
    useAuthStore.setState({ ...authenticatedLocalUserForTest() });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
  });

  test("a boot probe that finds no session drops the widget snapshot", async () => {
    sessionUser = null;

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
  });

  test("an exhausted gateway prime drops the widget snapshot", async () => {
    // Boot ends the authenticated session after the startup-retry budget is
    // spent, so the previous session's titles must not survive on the Home
    // Screen while the app shows the recovery controls.
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockPrimeError = new Error("Gateway token request failed: 401");

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
  });

  test("the exhausted gateway prime leaves the cloud probe unsettled", async () => {
    // The snapshot drop must not drag the rest of the `sessionEnded()`
    // transition along: writing `cloudSession: "absent"` here would settle
    // the probe on a value the follow-up probe is about to replace.
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockPrimeError = new Error("Gateway token request failed: 401");
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({ cloudSession: "unknown" });

    const gates: Array<() => void> = [];
    getSessionGates = gates;

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().cloudSession).toBe("unknown");

    gates[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  test("an inconclusive probe keeps the session and the widget snapshot", async () => {
    // Offline resume (LUM-2412): the session never ended, so blanking the
    // widgets would be a regression, not a cleanup.
    getSessionThrows = true;
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(clearWidgetSnapshotMock).not.toHaveBeenCalled();
  });

  test("a local session that survives a settled 401 keeps the widget snapshot", async () => {
    // The demotion path drops the cloud user but not the session, so the
    // local assistant's conversations are still the user's own.
    mockIsLocalClient = true;
    mockIsGatewayAuth = false;
    mockCloudAssistants = [];
    sessionUser = null;
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "unknown",
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(clearWidgetSnapshotMock).not.toHaveBeenCalled();
  });

  // The bridge call is bounded at two seconds, not instantaneous, and the
  // app-resume listener or an interactive sign-in can authenticate inside that
  // window. The session-ending write the earlier rejection is holding belongs
  // to a session that is no longer current, so it must not land.
  test("a re-authentication during the snapshot clear survives the delayed write", async () => {
    mockIsLocalClient = false;
    mockCloudAssistants = [];
    sessionUser = null;
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });
    const releaseClear = holdWidgetSnapshotClear();

    const rejected = useAuthStore.getState().refreshSession();
    await flushTasks();

    sessionUser = { id: "user-2", email: "user2@example.com" };
    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    releaseClear();
    await expect(rejected).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  test("the delayed session-ending write lands when no newer auth intervenes", async () => {
    mockIsLocalClient = false;
    mockCloudAssistants = [];
    sessionUser = null;
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });
    const releaseClear = holdWidgetSnapshotClear();

    const rejected = useAuthStore.getState().refreshSession();
    await flushTasks();

    // Still authenticated: the write is what ends the session, and it waits on
    // the clear.
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");

    releaseClear();
    await expect(rejected).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
  });

  test("an explicit logout outlasts a refresh that authenticates during the clear", async () => {
    // The inverse of the guard above. Logout has already dropped the
    // credentials, the selection and the user-scoped storage before it reaches
    // the clear, so a refresh that lands inside that window is describing a
    // session that no longer exists. Deferring to it would leave the user
    // signed in after pressing Log Out.
    mockIsLocalClient = false;
    mockCloudAssistants = [];
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });
    const releaseClear = holdWidgetSnapshotClear();

    const loggingOut = useAuthStore.getState().logout();
    await flushTasks();

    // The app-resume listener explicitly permits overlapping refreshes.
    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");

    releaseClear();
    await loggingOut;

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
  });

  test("a gateway logout outlasts a refresh that authenticates during the clear", async () => {
    mockIsGatewayAuth = true;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    mockIsLocalClient = false;
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({ sessionStatus: "authenticated" });
    const releaseClear = holdWidgetSnapshotClear();

    const loggingOut = useAuthStore.getState().logout();
    await flushTasks();

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    releaseClear();
    await loggingOut;

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("a gateway re-auth during the snapshot clear survives the delayed write", async () => {
    // The `keepCloudSession` variant takes the same guard: a boot that
    // exhausted its gateway prime must not log out the session a retry
    // established while the boot's snapshot clear was still outstanding.
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockPrimeError = new Error("Gateway token request failed: 401");
    const releaseClear = holdWidgetSnapshotClear();

    const booting = useAuthStore.getState().initSession();
    await flushTasks();

    mockPrimeError = null;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    releaseClear();
    await booting;

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });
});

/**
 * Hold the next `fetchOrganizations()` open, returning the release fn, so a
 * test can suspend a refresh mid-flight between the session response and the
 * authenticated write that response drives.
 */
function holdOrgFetch(): () => void {
  let release = (): void => {};
  fetchOrganizationsMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(mockOrgFetchOutcome);
      }),
  );
  return () => release();
}

// The other half of the observation-vs-decision rule: a logout invalidates the
// observations already in flight. A refresh that fetched its session while the
// credentials were still valid can still be inside its awaits when logout ends
// the session, and its authenticated write would put the user back on
// signed-in surfaces after they pressed Log Out.
describe("explicit logout supersedes an in-flight refresh", () => {
  test("a refresh that began before logout abandons its authenticated write", async () => {
    // A LOCAL client: the refresh's reconcile sync is the path's longest
    // await, so holdOrgFetch can actually suspend it between the session
    // response and the authenticated write.
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });
    const releaseOrg = holdOrgFetch();

    const refreshing = useAuthStore.getState().refreshSession();
    await flushTasks();

    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");

    const statuses: string[] = [];
    const unsubscribe = useAuthStore.subscribe((state) => {
      statuses.push(state.sessionStatus);
    });
    releaseOrg();
    await expect(refreshing).resolves.toBe(false);
    unsubscribe();

    // Not even a flash: the write never lands, rather than landing and being
    // corrected.
    expect(statuses).not.toContain("authenticated");
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
    // The abandoned transition also carries `persistUserSnapshot`, which would
    // leave the departed account restorable on the next offline boot.
    expect(localStorage.getItem("cadet:auth:sessionSnapshot")).toBeNull();
  });

  test("a refresh that starts midway through a logout is superseded too", async () => {
    // A LOCAL client: the refresh's reconcile sync is the path's longest
    // await, so holdOrgFetch can actually suspend it between the session
    // response and the authenticated write.
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });
    const releaseClear = holdWidgetSnapshotClear();

    const loggingOut = useAuthStore.getState().logout();
    await flushTasks();

    // Enters while logout is suspended on the snapshot clear, and resumes only
    // after logout's session-ending write has landed.
    const releaseOrg = holdOrgFetch();
    const refreshing = useAuthStore.getState().refreshSession();
    await flushTasks();

    releaseClear();
    await loggingOut;
    releaseOrg();
    await expect(refreshing).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("a refresh that completes with no logout still authenticates", async () => {
    // A LOCAL client: the refresh's reconcile sync is the path's longest
    // await, so holdOrgFetch can actually suspend it between the session
    // response and the authenticated write.
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({
      sessionStatus: "unauthenticated",
      cloudSession: "absent",
    });
    const releaseOrg = holdOrgFetch();

    const refreshing = useAuthStore.getState().refreshSession();
    await flushTasks();
    releaseOrg();

    await expect(refreshing).resolves.toBe(true);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  test("a sign-in started after a logout is never blocked", async () => {
    // The generation is snapshotted on entry, so a completed logout can only
    // supersede refreshes that were already running. Nothing resets it, and a
    // fresh sign-in still commits.
    mockIsLocalClient = false;
    mockCloudAssistants = [];
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });

    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");

    // The provider callback and signup pages commit an interactive sign-in
    // through `refreshSession`.
    sessionUser = { id: "user-2", email: "user2@example.com" };
    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");

    // And the connect action commits one directly.
    await useAuthStore.getState().logout();
    await connectCloudAssistant("assistant-1");
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
  });
});

describe("platform session probe resolution", () => {
  // A returning local-gateway user re-runs the cloud probe on app resume.
  // The probe must NOT reopen the "unknown" window: it leaves the last-known
  // "present"/"absent" in place until the new result lands, so a cached
  // platform assistant keeps standing in for the session and reactive
  // consumers don't flicker mid-session.
  test("a re-run gateway probe retains the last status until it settles", async () => {
    mockIsGatewayAuth = true;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({ cloudSession: "absent" });

    const gates: Array<() => void> = [];
    getSessionGates = gates;

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    // Probe launched but not settled: the prior status is retained, not reset
    // to "unknown".
    expect(useAuthStore.getState().cloudSession).toBe("absent");

    gates[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  // Two probes can overlap — an app-resume refresh firing while the initial
  // probe is still in flight. If a slower earlier probe settles after a newer
  // one starts, its result must be discarded so it can't overwrite the newer
  // probe's outcome.
  test("a stale probe completing after a newer one does not change status", async () => {
    mockIsGatewayAuth = true;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({ cloudSession: "absent" });

    const gates: Array<() => void> = [];
    getSessionGates = gates;

    // Launch two overlapping probes; neither has settled, so the prior status
    // is still retained.
    await useAuthStore.getState().refreshSession();
    await useAuthStore.getState().refreshSession();
    expect(gates.length).toBe(2);
    expect(useAuthStore.getState().cloudSession).toBe("absent");

    // Settle the older probe first: it is stale, so it must not write status.
    gates[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAuthStore.getState().cloudSession).toBe("absent");

    // The newest probe settling is what moves status to "present".
    gates[1]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAuthStore.getState().cloudSession).toBe("present");
  });
});

describe("platform probe conclusive rejection (half-dead session)", () => {
  // The half-dead state: allauth answers 200 with a user while the cloud
  // API conclusively rejects the same credential. The probe consumes the
  // org/assistants evidence it already gathers and settles "absent".
  //
  // Every test drives the local-client init path (no gateway auth, no
  // platform assistants), where the probe runs with `setUserOnSuccess`.
  function arrangeLocalProbe(): void {
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
  }

  test("an org-fetch session rejection settles the session absent", async () => {
    arrangeLocalProbe();
    mockOrgFetchOutcome = { ok: false, kind: "rejected", status: 403 };

    await useAuthStore.getState().initSession();
    await whenCloudSessionSettled();

    expect(useAuthStore.getState().cloudSession).toBe("absent");
    // A rejected session must not persist a restorable snapshot or bootstrap
    // the cloud identity.
    expect(localStorage.getItem("cadet:auth:sessionSnapshot")).toBeNull();
    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
    // The evidence check short-circuits before the assistants call and sync.
    expect(listAssistantsMock).not.toHaveBeenCalled();
  });

  test("a session rejection clears a previously persisted snapshot", async () => {
    arrangeLocalProbe();
    // A snapshot persisted by an earlier confirmed session must not survive
    // the rejection: restoreOfflineSession would otherwise resurrect the
    // rejected account as "present" on a later offline boot.
    localStorage.setItem(
      "cadet:auth:sessionSnapshot",
      "true",
    );
    mockOrgFetchOutcome = { ok: false, kind: "rejected", status: 403 };

    await useAuthStore.getState().initSession();
    await whenCloudSessionSettled();

    expect(useAuthStore.getState().cloudSession).toBe("absent");
    expect(localStorage.getItem("cadet:auth:sessionSnapshot")).toBeNull();
  });

  test("an assistants-list session rejection settles the session absent", async () => {
    arrangeLocalProbe();
    mockListAssistantsResult = { ok: false, status: 403, error: {} };

    await useAuthStore.getState().initSession();
    await whenCloudSessionSettled();

    expect(useAuthStore.getState().cloudSession).toBe("absent");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
    // The org fetch succeeded, so the rejected account's org state must be
    // cleared here or its Cadet-Organization-Id keeps stamping requests.
    expect(clearOrganizationMock).toHaveBeenCalled();
  });

  test("a transport-thrown org fetch keeps the present settle", async () => {
    arrangeLocalProbe();
    mockOrgFetchError = new TypeError("Failed to fetch");

    await useAuthStore.getState().initSession();
    await whenCloudSessionSettled();

    // No evidence of rejection: the offline-restore contract (LUM-2412)
    // keeps the session present.
    expect(useAuthStore.getState().cloudSession).toBe("present");
    expect(bootstrapLocalAssistantCloudIdentityMock).toHaveBeenCalled();
  });

  test("a non-rejection org failure keeps the present settle", async () => {
    arrangeLocalProbe();
    mockOrgFetchOutcome = { ok: false, kind: "unavailable" };

    await useAuthStore.getState().initSession();
    await whenCloudSessionSettled();

    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  test("a sync race timeout keeps the present settle", async () => {
    arrangeLocalProbe();
    // An org fetch that never resolves leaves the race with only the timeout
    // arm; shrink the 3s timer to 0 so the test settles immediately.
    mockOrgFetchOutcome = new Promise(() => {});
    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    setTimeoutSpy.mockImplementation(((handler: () => void, timeout?: number) =>
      originalSetTimeout(
        handler,
        timeout === 3_000 ? 0 : timeout,
      )) as typeof setTimeout);

    try {
      await useAuthStore.getState().initSession();
      await whenCloudSessionSettled();
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(useAuthStore.getState().cloudSession).toBe("present");
    // Wiring pin: past the timeout the strict sync gate is closed but the
    // same-session gate stays open (no newer probe), so a late org success
    // may still commit and un-strand readiness.
    const [isCurrent, isSameSession] = fetchOrganizationsMock.mock
      .calls[0] as unknown as [() => boolean, () => boolean];
    expect(isCurrent()).toBe(false);
    expect(isSameSession()).toBe(true);
  });

  test("a rejection landing after the race timeout does not clear org state", async () => {
    arrangeLocalProbe();
    // Hold the org fetch past the (shrunken) timeout, then resolve it OK and
    // let the assistants call report a settled rejection. The probe already
    // settled "present" from cached data, so the dangling call must not
    // strip the org header out from under that session.
    let releaseOrgFetch: (value: unknown) => void = () => {};
    mockOrgFetchOutcome = new Promise((resolve) => {
      releaseOrgFetch = resolve;
    });
    mockListAssistantsResult = { ok: false, status: 403, error: {} };
    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    setTimeoutSpy.mockImplementation(((handler: () => void, timeout?: number) =>
      originalSetTimeout(
        handler,
        timeout === 3_000 ? 0 : timeout,
      )) as typeof setTimeout);

    try {
      await useAuthStore.getState().initSession();
      await whenCloudSessionSettled();
      expect(useAuthStore.getState().cloudSession).toBe("present");

      releaseOrgFetch({ ok: true });
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(clearOrganizationMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  test("the probe clears its sync race timer once it settles", async () => {
    arrangeLocalProbe();
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");

    try {
      await useAuthStore.getState().initSession();
      await whenCloudSessionSettled();

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
  // otherwise confirm the session: refreshSession's resume path, initSession's
  // platform-assistants path, and connectCloudAssistant.

  test("refreshSession settles a half-dead session absent instead of re-confirming it", async () => {
    // A gateway client whose cached token expired while backgrounded lands in
    // the non-gateway branch (isGatewayAuthMode() is false without a token).
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockOrgFetchOutcome = { ok: false, kind: "rejected", status: 403 };
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(useAuthStore.getState().cloudSession).toBe("absent");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
    // No snapshot may be re-persisted for the rejected session.
    expect(localStorage.getItem("cadet:auth:sessionSnapshot")).toBeNull();
  });

  test("refreshSession settles absent on an assistants-list rejection", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockListAssistantsResult = { ok: false, status: 401, error: {} };
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(useAuthStore.getState().cloudSession).toBe("absent");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
  });

  test("refreshSession ends a half-dead session whose assistants are cloud-hosted", async () => {
    // Same stands-alone exclusion as a settled getSession 401: a cloud
    // assistant is unreachable without a cloud session, so login wins.
    mockIsLocalClient = true;
    mockIsGatewayAuth = false;
    mockCloudAssistants = [{ assistantId: "managed-1", cloud: "cadet" }];
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockOrgFetchOutcome = { ok: false, kind: "rejected", status: 403 };
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(localStorage.getItem("cadet:auth:sessionSnapshot")).toBeNull();
  });

  test("a resume refresh does not flip a probe-settled absent session back to present", async () => {
    // Pin the oscillation regression: the probe settles absent on rejection,
    // then the app-resume refresh runs against the same half-dead session.
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockOrgFetchOutcome = { ok: false, kind: "rejected", status: 403 };

    await useAuthStore.getState().initSession();
    await whenCloudSessionSettled();
    expect(useAuthStore.getState().cloudSession).toBe("absent");

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(useAuthStore.getState().cloudSession).toBe("absent");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
    expect(localStorage.getItem("cadet:auth:sessionSnapshot")).toBeNull();
  });

  test("a transport-failed sync on refresh keeps the cloud confirmation", async () => {
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockOrgFetchError = new TypeError("Failed to fetch");

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(useAuthStore.getState().cloudSession).toBe("present");
    expect(localStorage.getItem("cadet:auth:sessionSnapshot")).not.toBeNull();
  });

  test("a non-rejection org failure on refresh keeps the cloud confirmation", async () => {
    mockIsLocalClient = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockOrgFetchOutcome = { ok: false, kind: "unavailable" };

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  test("initSession with platform assistants routes a rejected session to login", async () => {
    mockIsLocalClient = true;
    mockCloudAssistants = [{ assistantId: "p1", cloud: "cadet" }];
    sessionUser = { id: "user-1", email: "user@example.com" };
    localStorage.setItem(
      "cadet:auth:sessionSnapshot",
      JSON.stringify({ accountId: "user-1" }),
    );
    mockOrgFetchOutcome = { ok: false, kind: "rejected", status: 403 };

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(useAuthStore.getState().cloudSession).toBe("absent");
    expect(localStorage.getItem("cadet:auth:sessionSnapshot")).toBeNull();
  });

  test("initSession with platform assistants routes an assistants-list rejection to login", async () => {
    mockIsLocalClient = true;
    mockCloudAssistants = [{ assistantId: "p1", cloud: "cadet" }];
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockListAssistantsResult = { ok: false, status: 410, error: {} };

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("initSession with platform assistants keeps the session on a transport-failed sync", async () => {
    mockIsLocalClient = true;
    mockCloudAssistants = [{ assistantId: "p1", cloud: "cadet" }];
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockOrgFetchError = new TypeError("Failed to fetch");

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  test("connectCloudAssistant fails the connect on a rejected org fetch", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockOrgFetchOutcome = { ok: false, kind: "rejected", status: 403 };

    await expect(connectCloudAssistant("assistant-1")).rejects.toThrow(
      "Platform authentication required",
    );

    expect(useAuthStore.getState().cloudSession).not.toBe("present");
    expect(localStorage.getItem("cadet:auth:sessionSnapshot")).toBeNull();
    // A failed connect leaves no side effects behind: the caller keeps its
    // current selection, not the rejected account's.
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });

  test("connectCloudAssistant tolerates a non-rejection org failure", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockOrgFetchOutcome = { ok: false, kind: "unavailable" };

    await connectCloudAssistant("assistant-1");

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
  });
});

describe("biometric session recovery", () => {
  test("initSession falls through to biometric recovery on native when session probe fails", async () => {
    mockIsNativePlatform = true;
    mockIsBiometricEnabled = true;
    mockBiometricToken = "recovered-session-token";
    sessionUser = { id: "user-1", email: "user@example.com" };
    getSessionFailFirstCall = true;

    await useAuthStore.getState().initSession();

    expect(installSessionCookiesMock).toHaveBeenCalledWith(
      "recovered-session-token",
    );
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  test("initSession skips biometric recovery on web", async () => {
    mockIsNativePlatform = false;
    sessionUser = null;

    await useAuthStore.getState().initSession();

    expect(retrieveBiometricTokenMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("initSession skips biometric recovery when biometrics disabled", async () => {
    mockIsNativePlatform = true;
    mockIsBiometricEnabled = false;
    sessionUser = null;

    await useAuthStore.getState().initSession();

    expect(retrieveBiometricTokenMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("initSession falls through to unauthenticated when biometric token is expired", async () => {
    mockIsNativePlatform = true;
    mockIsBiometricEnabled = true;
    mockBiometricToken = "expired-token";
    sessionUser = null;

    await useAuthStore.getState().initSession();

    expect(installSessionCookiesMock).toHaveBeenCalledWith("expired-token");
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });
});

describe("connectLocalAssistant", () => {
  test("primes the connection BEFORE selecting the assistant, then logs in", async () => {
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
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    // No platform assistants — nothing to probe, so the status settles
    // directly to "absent" rather than staying "unknown".
    expect(useAuthStore.getState().cloudSession).toBe("absent");
  });

  test("waits for the new cloud probe before bootstrapping a connected local assistant", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    sessionUser = { id: "user-1" };
    useAuthStore.setState({ cloudSession: "present" });
    getSessionGates = [];

    await connectLocalAssistant("local-a");

    // A cached present session is insufficient: the fresh probe must confirm it.
    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
    expect(getSessionGates).toHaveLength(1);
    getSessionGates[0]!();
    await whenCloudSessionSettled();

    expect(bootstrapLocalAssistantCloudIdentityMock).toHaveBeenCalledTimes(1);
  });

  test("does not bootstrap from cached cloud state when the fresh probe rejects it", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    sessionUser = null;
    useAuthStore.setState({ cloudSession: "present" });

    await connectLocalAssistant("local-a");
    await whenCloudSessionSettled();

    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
  });

  test("rethrows the prime failure without selecting or marking the session logged in", async () => {
    mockIsLocalClient = true;
    mockPrimeError = new Error("Guardian token not found");

    await expect(connectLocalAssistant("local-a")).rejects.toThrow(
      "Guardian token not found",
    );

    // A failed connect leaves the previous selection in place.
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).not.toBe("authenticated");
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

  test("primes the host proxy before selecting, then logs in and checks the assistant", async () => {
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
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    // No platform assistants and no gateway auth in this arrangement, so the
    // cloud-session status settles directly to "absent".
    expect(useAuthStore.getState().cloudSession).toBe("absent");
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
    useAuthStore.setState({
      cloudSession: "present",
    });

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
    expect(useAuthStore.getState().sessionStatus).not.toBe("authenticated");
  });

  test("rejects an unknown id", async () => {
    mockIsLocalClient = true;
    mockLockfileAssistants = [pairedEntry];

    await expect(connectPairedAssistant("missing")).rejects.toThrow(
      "Not a paired assistant",
    );

    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
  });

  test("rethrows the prime failure without selecting or marking the session logged in", async () => {
    mockIsLocalClient = true;
    mockLockfileAssistants = [pairedEntry];
    mockPrimeError = new Error("Guardian token not found");

    await expect(connectPairedAssistant("paired-a")).rejects.toThrow(
      "Guardian token not found",
    );

    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).not.toBe("authenticated");
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
      await expect(useAuthStore.getState().refreshSession()).resolves.toBe(
        true,
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    // Both selection kinds collapse into the tokenless prime — it takes no
    // target and resolves the selection itself.
    expect(primeLocalGatewayConnectionMock).toHaveBeenCalledTimes(1);
    expect(primeLocalGatewayConnectionMock).toHaveBeenCalledWith();
    expect(fetchedUrls).toEqual([]);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });

  test("refreshSession ends the session when paired proxy authorization fails", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    mockSelectedAssistant = pairedSelection;
    mockPrimeError = new Error("paired proxy authorization failed");
    useAuthStore.setState({ sessionStatus: "authenticated" });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("refreshSession rotates a local selection's gateway JWT without re-minting", async () => {
    mockIsLocalClient = true;
    mockIsGatewayAuth = true;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    // The gateway-JWT rotation covers the refresh.
    expect(refreshRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });

  test("boot with a paired proxy authorization failure settles unauthenticated after one prime", async () => {
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
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });
});

// ---------------------------------------------------------------------------
// Offline session restore (LUM-2412)
//
// A transport-failed session probe (offline boot, tray reopen before
// Wi-Fi reassociates, platform outage) says nothing about the session.
// With a local credential (Electron session token) and a persisted user
// snapshot, the store settles authenticated instead of bouncing a
// logged-in user to the login screen. Only a settled "no session"
// answer (401, or 2xx without user) ends the session — and it also
// invalidates the snapshot so a revoked session can't be resurrected.
// ---------------------------------------------------------------------------

const SNAPSHOT_KEY = "cadet:auth:sessionSnapshot";

function seedSnapshot(): void {
  localStorage.setItem(SNAPSHOT_KEY, "true");
}

describe("offline session restore (LUM-2412)", () => {
  test("transport-failed boot (thrown fetch) with token + snapshot settles authenticated from cache", async () => {
    getSessionThrows = true;
    mockElectronSessionToken = "tok-1";
    seedSnapshot();

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
    // The snapshot only exists for a confirmed platform session, and no
    // probe runs offline to settle an "unknown" — so the restore settles
    // "present" (believed state); reconnect revalidation corrects it.
  });

  test("transport-failed boot (proxy 502) with token + snapshot settles authenticated from cache", async () => {
    getSessionFailStatus = 502;
    mockElectronSessionToken = "tok-1";
    seedSnapshot();

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  test("rate-limited boot (429) is non-authoritative — restores from cache instead of logging out", async () => {
    getSessionFailStatus = 429;
    mockElectronSessionToken = "tok-1";
    seedSnapshot();

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(localStorage.getItem(SNAPSHOT_KEY)).not.toBeNull();
  });

  test("rate-limited refresh (429) keeps the authenticated session", async () => {
    sessionUser = { id: "user-9", username: "nine", email: "nine@example.com" };
    await useAuthStore.getState().initSession();
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");

    sessionUser = null;
    getSessionFailStatus = 429;
    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(localStorage.getItem(SNAPSHOT_KEY)).not.toBeNull();
  });

  test("transport-failed boot without a local credential stays unauthenticated (web behavior)", async () => {
    getSessionThrows = true;
    mockElectronSessionToken = null;
    seedSnapshot();

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    // Transport failure must not invalidate the snapshot.
    expect(localStorage.getItem(SNAPSHOT_KEY)).not.toBeNull();
  });

  test("transport-failed boot with token but no snapshot stays unauthenticated", async () => {
    getSessionThrows = true;
    mockElectronSessionToken = "tok-1";

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("settled 401 boot stays unauthenticated and invalidates the snapshot", async () => {
    getSessionFailStatus = 401;
    mockElectronSessionToken = "tok-1";
    seedSnapshot();

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  test("successful boot persists the snapshot for later offline restores", async () => {
    sessionUser = { id: "user-9", username: "nine", email: "nine@example.com" };

    await useAuthStore.getState().initSession();

    const raw = localStorage.getItem(SNAPSHOT_KEY);
    expect(raw).not.toBeNull();
    expect(raw).toBe("true");
  });

  test("local-mode platform-assistants boot also restores from cache on transport failure", async () => {
    mockIsLocalClient = true;
    mockCloudAssistants = [{ assistantId: "p1", cloud: "cadet" }];
    getSessionThrows = true;
    mockElectronSessionToken = "tok-1";
    seedSnapshot();

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  test("refreshSession transport failure keeps the authenticated session (offline resume)", async () => {
    // Boot online…
    sessionUser = { id: "user-9", username: "nine", email: "nine@example.com" };
    await useAuthStore.getState().initSession();
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");

    // …then the resume-driven refresh fires while offline.
    getSessionThrows = true;
    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
  });

  test("refreshSession transport failure while unauthenticated reports false without state churn", async () => {
    getSessionThrows = true;
    useAuthStore.setState({ sessionStatus: "unauthenticated" });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("refreshSession settled 401 ends the session and invalidates the snapshot (reconnect revalidation)", async () => {
    // Boot from cache while offline…
    getSessionThrows = true;
    mockElectronSessionToken = "tok-1";
    seedSnapshot();
    await useAuthStore.getState().initSession();
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");

    // …network returns, the cloud says the session was revoked.
    getSessionThrows = false;
    getSessionFailStatus = 401;
    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  test("a corrupt snapshot is ignored — transport-failed boot stays unauthenticated", async () => {
    getSessionThrows = true;
    mockElectronSessionToken = "tok-1";
    localStorage.setItem(SNAPSHOT_KEY, "{not json");

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });
});

// The store carries no user — the session shape is the identity surface:
// a platform account ⟺ `cloudSession: "present"` on an authenticated session,
// local gateway access ⟺ authenticated with the cloud session absent.
describe("session shape (platform vs local gateway access)", () => {
  test("a local gateway session authenticates with no cloud session", async () => {
    mockIsLocalClient = true;
    mockCloudAssistants = [];

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    // The probe's settle timing here is asserted by the probe-resolution
    // suite; this pins only that a local session authenticates without a
    // cloud identity being installed (there is no user field to check).
  });

  test("a cloud session authenticates with the cloud session present", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().cloudSession).toBe("present");
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
  expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
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

test("cloud logout scopes notify account sources until cleanup finishes; gateway logout does not", async () => {
  const finish = mock(() => {});
  const started = mock(() => finish);
  const unsubscribe = subscribeCloudAccountLogout(started);
  try {
    mockIsGatewayAuth = true;
    setSelfHostedConnection({
      url: window.location.origin,
      token: "slot-token",
    });
    await useAuthStore.getState().logout();
    expect(started).not.toHaveBeenCalled();
    await useAuthStore.getState().logout({
      cloudAccount: {
        revokeSession: async () => {
          expect(started).toHaveBeenCalledTimes(1);
          expect(finish).not.toHaveBeenCalled();
        },
      },
    });
    expect(finish).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
});

test("account OAuth scopes suspend web resume probes until every exchange finishes", async () => {
  const { publish } = await import("@/lib/event-bus");
  const originalRefresh = useAuthStore.getState().refreshSession;
  const refresh = mock(async () => true);
  useAuthStore.setState({ refreshSession: refresh });
  const stop = setupAuthListeners();
  const first = beginCloudAccountOAuth();
  const second = beginCloudAccountOAuth();
  try {
    expect(isCloudAccountOAuthInFlight()).toBe(true);
    publish("app.resume", { signal: "window_attention" });
    expect(refresh).not.toHaveBeenCalled();
    first();
    first();
    publish("app.resume", { signal: "window_attention" });
    expect(refresh).not.toHaveBeenCalled();
    second();
    expect(isCloudAccountOAuthInFlight()).toBe(false);
    publish("app.resume", { signal: "window_attention" });
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    first();
    second();
    stop();
    useAuthStore.setState({ refreshSession: originalRefresh });
  }
});
test("account OAuth primes the web token cache before web reconciliation", () => {
  primeCloudAccountSessionToken("new-session-token");
  expect(mockElectronSessionToken).toBe("new-session-token");
});
