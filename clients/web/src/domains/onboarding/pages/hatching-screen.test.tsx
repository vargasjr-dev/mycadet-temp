/**
 * Behavioral tests for the post-payment provisioning wait behind the onboarding
 * hatching screen.
 *
 * A Pro user hatches a small warm-pool assistant; the screen fires the
 * idempotent ensure-provisioned reconcile once and holds completion until the
 * machine/storage resize to the purchased specs converges (then re-probes
 * healthz). Failures, free orgs, and the hard cap all fall through to completion
 * so the user is never trapped. Local hatches never enter this path.
 *
 * The screen keeps module-level hatch guards, so every test drives the flow to a
 * genuine completion (which releases them) to stay isolated. Self-contained
 * mocks — run this file solo (`mock.module` leaks across a shared `bun test`
 * run).
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import type { ReactNode } from "react";

// --- Mutable per-test state, reset in beforeEach ------------------------------

const navigateMock = mock((_to: string, _opts?: unknown) => {});
let searchParams = new URLSearchParams();

let isLocalClientValue = false;

// Whether the no-id pre-flight getAssistant resolves an already-active
// assistant (the reload path, Fix 3).
let preflightActive = false;
// Whether the no-id pre-flight resolves the SELECTED LOCKFILE assistant, which
// is what `getAssistant()` answers with under gateway auth in a local-mode
// build: always `status: "active", is_local: true`.
let preflightGatewaySelectedLocal = false;

const GATEWAY_SELECTED_LOCAL_ID = "local-selected-1";

interface AssistantShape {
  id: string;
  status: string;
  machine_size: string | null;
  provisioned_storage_gib: number | null;
  is_local?: boolean;
}
let currentAssistant: AssistantShape;

// The active-detection poll is the first id-keyed getAssistant; later id-polls
// are the resize loop and may advance the fake clock so the cap-expiry path is
// exercised without a real 90s wait.
let idPollCount = 0;
let resizePollClockStepMs = 0;

// test that never reaches a confirmed-Pro read advances the clock here instead.

// --- Mocks --------------------------------------------------------------------

const getAssistantMock = mock(async (id?: string) => {
  if (!id) {
    if (preflightGatewaySelectedLocal) {
      return {
        ok: true as const,
        status: 200,
        data: {
          id: GATEWAY_SELECTED_LOCAL_ID,
          status: "active",
          is_local: true,
          machine_size: null,
          provisioned_storage_gib: null,
        },
      };
    }
    if (preflightActive) {
      // Reload onto an already-active assistant.
      return { ok: true as const, status: 200, data: { ...currentAssistant } };
    }
    // Pre-flight with no id: no assistant exists yet (auto_hatch).
    return { ok: false as const, status: 404, error: {} };
  }
  idPollCount += 1;
  if (idPollCount >= 2 && resizePollClockStepMs > 0) {
    setSystemTime(new Date(Date.now() + resizePollClockStepMs));
  }
  return { ok: true as const, status: 200, data: { ...currentAssistant } };
});

// Healthz is probed twice per paid hatch: once in the connecting phase, once
// after the provisioning wait. `healthzUnhealthyFromCall` makes every probe from
// that 1-based ordinal onward answer unhealthy, so the post-provisioning probe
// can be failed without also stalling the connecting phase.
let healthzCallCount = 0;
let healthzUnhealthyFromCall = Number.POSITIVE_INFINITY;
let healthzPollClockStepMs = 0;

const getAssistantHealthzMock = mock(async (_id: string) => {
  healthzCallCount += 1;
  if (healthzCallCount >= healthzUnhealthyFromCall) {
    if (healthzPollClockStepMs > 0) {
      setSystemTime(new Date(Date.now() + healthzPollClockStepMs));
    }
    return { ok: false as const, status: 503, data: {} };
  }
  return { ok: true as const, status: 200, data: {} };
});

const hatchAssistantMock = mock(async () => ({
  ok: true as const,
  status: 201,
  data: { id: "asst-1", status: "provisioning" },
}));

const hatchLocalAssistantMock = mock(async (_remote?: string) => ({
  ok: true as const,
  assistantId: "local-1",
}));

const clearGatewayTokenMock = mock(() => {});
const setSelfHostedConnectionMock = mock((_connection: unknown) => {});

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams],
}));

mock.module("@/lib/error-reporting/capture-error", () => ({
  captureError: () => {},
}));

const stableQueryClient = {};
mock.module("@tanstack/react-query", () => ({
  useQueryClient: () => stableQueryClient,
}));

mock.module("@/assistant/api", () => ({
  getAssistant: getAssistantMock,
  getAssistantHealthz: getAssistantHealthzMock,
  hatchAssistant: hatchAssistantMock,
}));

mock.module("@/generated/api/sdk.gen", () => ({}));

mock.module("@/assistant/seed-hatch-avatar", () => ({
  seedHatchAvatar: async () => {},
}));

mock.module("@/assistant/lifecycle", () => ({
  isCloudHostedDisabled: () => false,
  PLATFORM_HOSTED_DISABLED_MESSAGE: "disabled",
  shouldRecoverFromHatchFailure: () => true,
  resolveAssistantLifecycleState: (result: {
    ok?: boolean;
    status?: number;
    data?: { status?: string; is_local?: boolean };
  }) => {
    if (result?.ok && result.data?.status === "active") {
      // Mirrors the real projection: an active assistant flagged `is_local`
      // is self-hosted, never the cloud `active` the hatch is waiting for.
      return result.data.is_local
        ? { kind: "self_hosted" }
        : { kind: "active" };
    }
    if (!result?.ok && result.status === 404) {
      return { kind: "auto_hatch" };
    }
    return { kind: "provisioning" };
  },
}));

mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: {
    checkAssistant: async () => {},
  },
}));

mock.module("@/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: ReactNode }) => children,
}));

mock.module("@/domains/onboarding/prefs", () => ({
  readSelectedVersion: () => "",
  writeSelectedVersion: () => {},
}));

// Stands in for the real error class (the screen's `instanceof` check runs
// against this mocked module's export).
class MockProviderKeyRejectedError extends Error {
  constructor(
    readonly provider: string,
    readonly reason?: string,
  ) {
    super(reason ?? `${provider} rejected the API key`);
  }
}

const applyPendingProviderKeyMock = mock(async () => {});

mock.module("@/domains/onboarding/provider-key", () => ({
  applyPendingProviderKey: applyPendingProviderKeyMock,
  ProviderKeyRejectedError: MockProviderKeyRejectedError,
}));

mock.module("@/domains/onboarding/plugin-attribution", () => ({
  ATTRIBUTED_PLUGIN_PARAM: "attributed_plugin",
}));

mock.module("@/lib/local-mode", () => ({
  isLocalClient: () => isLocalClientValue,
  loadLockfile: async () => {},
  primeLocalGatewayConnection: async () => {},
  probeLocalGatewayReady: async () => true,
}));

mock.module("@/lib/auth/gateway-session", () => ({
  clearGatewayToken: clearGatewayTokenMock,
}));

mock.module("@/lib/self-hosted/connection", () => ({
  setSelfHostedConnection: setSelfHostedConnectionMock,
}));

mock.module("@/lib/navigation/navigation-resolver", () => ({
  POST_CHECKOUT_HATCH_PARAM: "post_checkout",
  resolveNavigation: () => ({ action: "proceed" }),
}));

mock.module("@/lib/navigation/build-state", () => ({
  buildNavigationState: () => ({}),
}));

mock.module("@/runtime/local-mode-host", () => ({
  hatchLocalAssistant: hatchLocalAssistantMock,
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => false,
}));

mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: () => {},
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      sessionStatus: () => "authenticated",
    },
    getState: () => ({
      connectLocalAssistant: async () => {},
    }),
  },
}));

mock.module("@/stores/organization-store", () => ({
  getActiveOrganizationIdForRequests: () => null,
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({ upsertFromApi: () => {} }),
  },
}));

mock.module("@/stores/session-status", () => ({
  isSessionSettled: () => true,
}));

mock.module("@/utils/api-errors", () => ({
  extractErrorMessage: (_error: unknown, _detail: unknown, fallback: string) =>
    fallback,
}));

mock.module("@/utils/avatar-bundled-components", () => ({
  BUNDLED_COMPONENTS: {},
}));

mock.module("@/utils/avatar-random", () => ({
  randomCharacterTraits: () => ({
    bodyShape: "a",
    eyeStyle: "b",
    color: "c",
  }),
}));

mock.module("@/utils/avatar-svg-compositor", () => ({
  composeSvg: () => "<svg></svg>",
}));

mock.module("@/utils/routes", () => ({
  routes: {
    assistant: "/assistant",
    onboarding: {
      research: "/onboarding/research",
      hosting: "/onboarding/hosting",
      privacy: "/onboarding/privacy",
      apiKey: "/onboarding/api-key",
    },
  },
}));

mock.module("@mycadet/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));

mock.module("@mycadet/design-library/components/progress-bar", () => ({
  ProgressBar: () => <div data-testid="progress-bar" />,
}));

const { HatchingScreen } =
  await import("@/domains/onboarding/pages/hatching-screen");

// --- Suite --------------------------------------------------------------------

describe("HatchingScreen — post-payment provisioning wait", () => {
  beforeEach(() => {
    setSystemTime();
    navigateMock.mockClear();
    getAssistantMock.mockClear();
    getAssistantHealthzMock.mockClear();
    hatchAssistantMock.mockClear();
    hatchLocalAssistantMock.mockClear();
    applyPendingProviderKeyMock.mockClear();
    applyPendingProviderKeyMock.mockImplementation(async () => {});
    clearGatewayTokenMock.mockClear();
    setSelfHostedConnectionMock.mockClear();
    searchParams = new URLSearchParams();
    isLocalClientValue = false;
    preflightActive = false;
    preflightGatewaySelectedLocal = false;
    idPollCount = 0;
    resizePollClockStepMs = 0;
    healthzCallCount = 0;
    healthzUnhealthyFromCall = Number.POSITIVE_INFINITY;
    healthzPollClockStepMs = 0;
    currentAssistant = {
      id: "asst-1",
      status: "active",
      machine_size: "small",
      provisioned_storage_gib: 10,
    };
  });

  afterEach(() => {
    cleanup();
    setSystemTime();
  });

  test("skip_research hands off to chat instead of the research funnel", async () => {
    const env = import.meta.env as Record<string, string | undefined>;
    const previousEnv = env.VITE_ENVIRONMENT;
    env.VITE_ENVIRONMENT = "staging";
    searchParams = new URLSearchParams("skip_research=1");

    try {
      render(<HatchingScreen />);

      await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
        timeout: 5000,
      });
      expect(navigateMock).toHaveBeenCalledWith("/assistant?onboarding=1", {
        replace: true,
      });
    } finally {
      env.VITE_ENVIRONMENT = previousEnv;
    }
  });

  test("local hatches never provision", async () => {
    isLocalClientValue = true;
    searchParams = new URLSearchParams("hosting=docker");

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
  });

  // -- managed hatch in a local-mode build --------------------------------
  //
  // The post-checkout funnel sends a local-mode client here with
  // `hosting=cadet-cloud`: the plan was bought for a cloud assistant the
  // org does not have yet, so the assistant is provisioned on the cloud and
  // the purchased machine and storage must land before the screen completes.

  test("a cloud hatch drops the gateway session and routes to the cloud", async () => {
    // Under gateway auth `getAssistant()` answers from the selected lockfile
    // entry. That entry is self-hosted, so it is never mistaken for the
    // cloud assistant being hatched: the hatch still runs and the lockfile
    // is never touched on the way through.
    isLocalClientValue = true;
    searchParams = new URLSearchParams("hosting=cadet-cloud");
    preflightGatewaySelectedLocal = true;

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });

    expect(hatchAssistantMock).toHaveBeenCalled();
    // The local gateway is dropped up front so the hatch, its polls and its
    // healthz probes address the cloud.
    expect(clearGatewayTokenMock).toHaveBeenCalled();
    expect(setSelfHostedConnectionMock).toHaveBeenCalledWith(null);
  });

  test("a provider-rejected API key surfaces an Update API key path, and the corrected pass reuses the hatched assistant", async () => {
    isLocalClientValue = true;
    searchParams = new URLSearchParams("hosting=local");
    applyPendingProviderKeyMock.mockImplementation(async () => {
      throw new MockProviderKeyRejectedError(
        "anthropic",
        "API key is invalid or expired.",
      );
    });

    render(<HatchingScreen />);

    // The rejection surfaces as a correctable error, not a completed hatch.
    await waitFor(
      () => expect(screen.getByText("Your API key didn't work")).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(
      screen.getByText("API key is invalid or expired.", { exact: false }),
    ).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
    // A blind retry would re-apply nothing (the pending key was cleared), so
    // the primary action is the path back to the API-key screen instead.
    expect(screen.queryByText("Try again")).toBeNull();
    screen.getByText("Update API key").click();
    expect(navigateMock).toHaveBeenCalledWith(
      "/onboarding/api-key?hosting=local",
      { replace: true },
    );

    // Returning with a corrected key remounts the screen. The held module
    // guard must hand back the SAME hatched assistant: one hatch total.
    cleanup();
    navigateMock.mockClear();
    applyPendingProviderKeyMock.mockImplementation(async () => {});

    render(<HatchingScreen />);

    await waitFor(
      () =>
        expect(navigateMock).toHaveBeenCalledWith(
          expect.stringContaining("/onboarding/research"),
          { replace: true },
        ),
      { timeout: 5000 },
    );
    expect(hatchLocalAssistantMock).toHaveBeenCalledTimes(1);
  }, 15000);

  test("switching hosting modes after a rejected key hatches fresh for the new mode instead of reusing the old assistant", async () => {
    // First pass: a Local hatch whose key is rejected parks on the error
    // screen with the hatch guard held.
    isLocalClientValue = true;
    searchParams = new URLSearchParams("hosting=local");
    applyPendingProviderKeyMock.mockImplementation(async () => {
      throw new MockProviderKeyRejectedError(
        "anthropic",
        "API key is invalid or expired.",
      );
    });

    render(<HatchingScreen />);

    await waitFor(
      () => expect(screen.getByText("Your API key didn't work")).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(hatchLocalAssistantMock).toHaveBeenCalledTimes(1);
    expect(hatchLocalAssistantMock.mock.calls[0]?.[0]).toBeUndefined();

    // The user backs out to the hosting screen and picks Docker instead. The
    // held Local promise must not answer for the Docker choice.
    cleanup();
    navigateMock.mockClear();
    applyPendingProviderKeyMock.mockImplementation(async () => {});
    searchParams = new URLSearchParams("hosting=docker");

    render(<HatchingScreen />);

    await waitFor(
      () =>
        expect(navigateMock).toHaveBeenCalledWith(
          expect.stringContaining("/onboarding/research"),
          { replace: true },
        ),
      { timeout: 5000 },
    );
    expect(hatchLocalAssistantMock).toHaveBeenCalledTimes(2);
    expect(hatchLocalAssistantMock.mock.calls[1]?.[0]).toBe("docker");
  }, 15000);

  test("a local hatch keeps its gateway session", async () => {
    isLocalClientValue = true;
    searchParams = new URLSearchParams("hosting=docker");

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    // The local hatch's own handoff re-primes the connection; the cloud
    // teardown must not have run ahead of it.
    expect(setSelfHostedConnectionMock).not.toHaveBeenCalled();
  });

  // -- post-checkout return -----------------------------------------------
  //
});
