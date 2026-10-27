import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { LockfileAssistant } from "@/lib/local-mode";

const isLocalClientMock = mock(() => true);
const hasAssistantsMock = mock(() => false);
let mockSelectedAssistant: LockfileAssistant | undefined;

// Spread the real module so the resolvers the route fork pulls in
// (`getActiveAssistant`/`isLocalAssistant`/…) stay available; override only
// the hosting-mode flags and the selected-assistant resolver per case.
const localModeActual = await import("@/lib/local-mode");
mock.module("@/lib/local-mode", () => ({
  ...localModeActual,
  isLocalClient: isLocalClientMock,
  hasAssistants: hasAssistantsMock,
  getActiveAssistant: () => mockSelectedAssistant,
  isLocalAssistant: (a: {
    cloud?: string;
    resources?: { gatewayPort?: number };
  }) => a.cloud !== "cadet" && a.resources?.gatewayPort != null,
  isCadetCloudRemote: () => false,
  getSelfHostedActorToken: () => (mockGatewayTokenPresent ? "gw-token" : null),
}));

// Drive the gateway session off a flag (the slot's token is the credential).
let mockGatewayTokenPresent = false;

// Clamp whenStoreState timeouts so hydration-timeout paths are testable
// without real 5s waits; untimed waits and predicate semantics are the real
// implementation's. Bind the real function BEFORE registering the mock —
// mock.module patches the imported namespace object in place, so a call-time
// `actual.whenStoreState` lookup would resolve to this wrapper and recurse.
const WAIT_TIMEOUT_CLAMP_MS = 100;
const whenStoreStateReal = (await import("@/utils/when-store-state"))
  .whenStoreState;
mock.module("@/utils/when-store-state", () => ({
  whenStoreState: ((store, predicate, options) =>
    whenStoreStateReal(store, predicate, {
      ...options,
      ...(options?.timeoutMs !== undefined
        ? { timeoutMs: Math.min(options.timeoutMs, WAIT_TIMEOUT_CLAMP_MS) }
        : {}),
    })) as typeof whenStoreStateReal,
}));

// The guard re-runs itself through the router when a timed-out probe reports
// late. Most cases stub the route tree so the assertion is on the re-run being
// armed, not on routing. `liveRouter` swaps in a real React Router instance so
// one case can assert what `revalidate()` actually does to the guard.
const revalidateMock = mock(() => {});
let liveRouter: { revalidate: () => Promise<void> } | null = null;
mock.module("@/routes", () => ({
  router: {
    revalidate: (): Promise<void> => {
      revalidateMock();
      return liveRouter?.revalidate() ?? Promise.resolve();
    },
  },
}));

import { authMiddleware } from "./auth-middleware";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

const initialAuthState = useAuthStore.getState();

const localAssistant: LockfileAssistant = {
  assistantId: "local-a",
  cloud: "local",
  resources: { gatewayPort: 51234, daemonPort: 51235 },
};

/**
 * Run the middleware and report whether it admitted (called `next`) or threw a
 * redirect Response — so admit-path assertions don't have to special-case the
 * thrown-Response contract.
 */
async function runMiddlewareOutcome(
  pathname: string,
): Promise<{ admitted: true } | { admitted: false; response: Response }> {
  const args = {
    request: new Request(`http://localhost${pathname}`),
    context: { set: () => {}, get: () => null },
  } as unknown as Parameters<typeof authMiddleware>[0];
  const next = (async () => new Response()) as Parameters<
    typeof authMiddleware
  >[1];
  try {
    await authMiddleware(args, next);
    return { admitted: true };
  } catch (thrown) {
    if (thrown instanceof Response) {
      return { admitted: false, response: thrown };
    }
    throw thrown;
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  isLocalClientMock.mockImplementation(() => true);
  hasAssistantsMock.mockImplementation(() => false);
  mockSelectedAssistant = undefined;
  mockGatewayTokenPresent = false;
  revalidateMock.mockClear();
  liveRouter = null;
  useAuthStore.setState(initialAuthState, true);
  useResolvedAssistantsStore.setState({
    assistants: [],
    activeAssistantId: null,
  });
});

afterEach(async () => {
  // Let a re-run armed by a timed-out wait fire and detach here instead of
  // in the next test, then drain its lazy router import.
  useAuthStore.setState({ cloudSession: "absent" });
  await tick();
  useAuthStore.setState(initialAuthState, true);
});

describe("authMiddleware — local-mode onboarding fork", () => {
  test("waits for the cloud-session probe before choosing hosting vs welcome", async () => {
    useAuthStore.setState({ cloudSession: "unknown" });

    let settled: { admitted: boolean } | null = null;
    const pending = runMiddlewareOutcome(routes.identity).then((outcome) => {
      settled = outcome;
    });

    // Probe still in flight: the middleware must not have decided yet, so a
    // returning platform user isn't prematurely sent to the welcome flow.
    await tick();
    expect(settled).toBeNull();

    // Probe settles with a live platform session. The hosting fork targets
    // the app bundle — a full-page navigation, so the middleware admits and
    // the page URL carries it.
    useAuthStore.setState({ cloudSession: "present" });
    await pending;

    expect(settled!.admitted).toBe(true);
    expect(window.location.href.endsWith(routes.onboarding.hosting)).toBe(true);
  });

  test("admits a resolved session with no platform session — the app bundle owns the welcome fork", async () => {
    // The local front door (welcome) moved into the app bundle (#523): web
    // never hosts it, so an authenticated local user whose cloud session is
    // absent is admitted here and the shell steers the onboarding fork.
    useAuthStore.setState({ cloudSession: "absent" });

    // The welcome fork targets the app bundle's front door — a full-page
    // navigation, so the middleware admits and the page URL carries it.
    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
    expect(window.location.href.endsWith(routes.welcome)).toBe(true);
  });

  test("a cloud session that never settles admits instead of looping — the app bundle owns the welcome fork", async () => {
    // Same #523 split: the guard deciding on a settled-absent session (rather
    // than re-entering the wait) is the no-loop guarantee; where the user goes
    // next is the app bundle's call, not web's redirect.
    useAuthStore.setState({ cloudSession: "unknown" });

    // The probe stays "unknown" for the whole (clamped) wait, so the guard
    // decides on a settled-absent session rather than re-entering the wait.
    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
    expect(window.location.href.endsWith(routes.welcome)).toBe(true);
  });

  test("routes to hosting when a resolved platform session exists", async () => {
    useAuthStore.setState({ cloudSession: "present" });

    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
    expect(window.location.href.endsWith(routes.onboarding.hosting)).toBe(true);
  });
});

describe("authMiddleware — app-access admit gate", () => {
  // A local user with at least one assistant resolved and a reachable gateway
  // connection, but no platform identity.
  function makeLocalUserReachable(): void {
    hasAssistantsMock.mockImplementation(() => true);
    mockSelectedAssistant = localAssistant;
    mockGatewayTokenPresent = true;
    useResolvedAssistantsStore.setState({
      assistants: [localAssistant] as never[],
      // The selected local assistant is the one the lifecycle activated, so its
      // gateway token counts as a per-assistant reachability signal.
      activeAssistantId: localAssistant.assistantId,
    });
  }

  test("admits a local-only user (no platform session) instead of redirecting to login", async () => {
    makeLocalUserReachable();
    // A local desktop user with no platform identity: the boot resolution
    // answered through the gateway short-circuit — settled and live — even
    // though the cloud probe settled absent.
    useAuthStore.setState({ cloudSession: "absent" });

    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
  });

  test("a cloud 401 mid-session does not redirect a local user", async () => {
    makeLocalUserReachable();
    // Start admitted as a local user.
    useAuthStore.setState({ cloudSession: "present" });
    expect((await runMiddlewareOutcome(routes.identity)).admitted).toBe(true);

    // Platform getSession() returns 401 mid-session: cloudSession flips to
    // absent, but the guard has no session input left to react to — the
    // resolution's reconnecting UI owns session death, not the guard.
    useAuthStore.setState({ cloudSession: "absent" });

    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
  });

  test("research proceeds without waiting for web consent or assistant hydration", async () => {
    isLocalClientMock.mockImplementation(() => false);
    useAuthStore.setState({ cloudSession: "present" });
    useResolvedAssistantsStore.setState({ assistants: [] });
    const href = window.location.href;
    const outcome = await runMiddlewareOutcome(
      `${routes.onboarding.research}?hosting=cadet-cloud`,
    );
    expect(outcome.admitted).toBe(true);
    expect(window.location.href).toBe(href);
  });
});
