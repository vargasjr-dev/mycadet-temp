import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { LockfileAssistant } from "@/lib/local-mode";

const isLocalClientMock = mock(() => true);
const hasAssistantsMock = mock(() => false);
let mockSelectedAssistant: LockfileAssistant | undefined;

// Spread the real module so the resolvers the route fork pulls in
// (`getSelectedAssistant`/`isLocalAssistant`/…) stay available; override only
// the hosting-mode flags and the selected-assistant resolver per case.
const localModeActual = await import("@/lib/local-mode");
mock.module("@/lib/local-mode", () => ({
  ...localModeActual,
  isLocalClient: isLocalClientMock,
  hasAssistants: hasAssistantsMock,
  getSelectedAssistant: () => mockSelectedAssistant,
  getActiveAssistant: () => mockSelectedAssistant,
  isLocalAssistant: (a: {
    cloud?: string;
    resources?: { gatewayPort?: number };
  }) => a.cloud !== "cadet" && a.resources?.gatewayPort != null,
  isCadetCloudRemote: () => false,
  getSelfHostedActorToken: () => (mockGatewayTokenPresent ? "gw-token" : null),
  isGatewaySessionLive: () => mockGatewayAuthMode,
}));

// Drive the gateway session off a flag (the slot's token is the credential).
let mockGatewayTokenPresent = false;
let mockGatewayAuthMode = false;

// Consent prefs are read by buildNavigationState; pinned current by default so
// the consent gate doesn't interfere with the session-admission assertions
// below. `consentPrefs` lets a case drive the boot defaults instead.
const consentPrefs = {
  tos: true,
  privacy: true,
};
const prefsActual = await import("@/domains/onboarding/prefs");
mock.module("@/domains/onboarding/prefs", () => ({
  ...prefsActual,
  readTosAccepted: () => consentPrefs.tos,
  readPrivacyConsent: () => consentPrefs.privacy,
}));

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

let resolutionState: AssistantResolutionState = { kind: "loading" };
const resolutionListeners = new Set<() => void>();
function setResolutionState(next: AssistantResolutionState) {
  resolutionState = next;
  for (const listener of resolutionListeners) {
    listener();
  }
}

mock.module("@/assistant/queries", () => ({
  useAssistantResolution: () => ({
    state: useSyncExternalStore(
      (cb) => {
        resolutionListeners.add(cb);
        return () => resolutionListeners.delete(cb);
      },
      () => resolutionState,
    ),
  }),
}));

import type { AssistantResolutionState } from "@/assistant/types";
import { useSyncExternalStore } from "react";

import { authMiddleware } from "./auth-middleware";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useAuthStore, type AuthUser } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

const initialAuthState = useAuthStore.getState();
const fakeUser = { id: "user-123" } as AuthUser;

const localAssistant: LockfileAssistant = {
  assistantId: "local-a",
  cloud: "local",
  resources: { gatewayPort: 51234, daemonPort: 51235 },
};

// The cloud hardcodes the non-native Stripe `success_url` to this path, and
// the pricing funnel has a brand-new user pay before an assistant exists.
// Billing lives under `ActiveAssistantGate`, so admitting the return strands
// the (paying) user on "Connecting to your assistant…" forever.

// the assistant. Every client lands on the headless research onboarding, which
// runs the purchased-provisioning wait behind the form.
const researchFunnelEntry = `${routes.onboarding.research}?hosting=cadet-cloud`;

/**
 * A checkout return on a local-mode client whose lockfile already holds a
 * self-hosted assistant. `hasAssistants()` is true, so the cold-boot probe wait
 * does not apply, yet the funnel decision still hangs on the probe.
 */
/** Poll until `predicate` holds, giving router-driven work room to settle. */
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

async function runMiddleware(pathname: string): Promise<Response> {
  const args = {
    request: new Request(`http://localhost${pathname}`),
    context: { set: () => {}, get: () => null },
  } as unknown as Parameters<typeof authMiddleware>[0];
  const next = (async () => new Response()) as Parameters<
    typeof authMiddleware
  >[1];
  // The middleware signals an unauthenticated/onboarding redirect by *throwing*
  // a Response, so surface that as the resolved value for assertions.
  try {
    await authMiddleware(args, next);
  } catch (thrown) {
    if (thrown instanceof Response) {
      return thrown;
    }
    throw thrown;
  }
  throw new Error("expected a redirect to be thrown");
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  isLocalClientMock.mockImplementation(() => true);
  hasAssistantsMock.mockImplementation(() => false);
  consentPrefs.tos = true;
  consentPrefs.privacy = true;
  mockSelectedAssistant = undefined;
  mockGatewayTokenPresent = false;
  mockGatewayAuthMode = false;
  revalidateMock.mockClear();
  liveRouter = null;
  useAuthStore.setState(initialAuthState, true);
  useResolvedAssistantsStore.setState({
    assistants: [],
    activeAssistantId: null,
  });
  setResolutionState({ kind: "error", message: "no assistant" });
});

afterEach(async () => {
  // Settle the probe so a re-run armed by a timed-out wait fires and detaches
  // here instead of in the next test, then drain its lazy router import.
  useAuthStore.setState({ cloudSession: "absent" });
  await tick();
  useAuthStore.setState(initialAuthState, true);
});

describe("authMiddleware — local-mode onboarding fork", () => {
  test("waits for the cloud-session probe before choosing hosting vs welcome", async () => {
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      cloudSession: "unknown",
    });

    let settled: Response | null = null;
    const pending = runMiddleware(routes.identity).then((res) => {
      settled = res;
    });

    // Probe still in flight: the middleware must not have decided yet, so a
    // returning platform user isn't prematurely sent to the welcome flow.
    await tick();
    expect(settled).toBeNull();

    // Probe settles with a live platform session.
    useAuthStore.setState({ cloudSession: "present" });
    await pending;

    expect(settled).not.toBeNull();
    expect(settled!.status).toBe(302);
    expect(settled!.headers.get("Location")).toBe(routes.onboarding.hosting);
  });

  test("admits a resolved session with no platform session — the app bundle owns the welcome fork", async () => {
    // The local front door (welcome) moved into the app bundle (#523): web
    // never hosts it, so an authenticated local user whose cloud session is
    // absent is admitted here and the shell steers the onboarding fork.
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      cloudSession: "absent",
    });

    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
  });

  test("a probe that never settles admits instead of looping — the app bundle owns the welcome fork", async () => {
    // Same #523 split: the guard deciding on a settled-absent session (rather
    // than re-entering the wait) is the no-loop guarantee; where the user goes
    // next is the app bundle's call, not web's redirect.
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      cloudSession: "unknown",
    });

    // The probe stays "unknown" for the whole (clamped) wait, so the guard
    // decides on a settled-absent session rather than re-entering the wait.
    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
  });

  test("routes to hosting when a resolved platform session exists", async () => {
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      cloudSession: "present",
    });

    const res = await runMiddleware(routes.identity);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(routes.onboarding.hosting);
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
    // A local desktop user with no platform identity: the gateway is the sole
    // session authority (#35152), so the local session is 'authenticated' even
    // though the cloud probe settled absent.
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: null,
      cloudSession: "absent",
    });

    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
  });

  test("a cloud 401 mid-session does not redirect a local user", async () => {
    makeLocalUserReachable();
    // Start admitted as a local user.
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: null,
      cloudSession: "present",
    });
    expect((await runMiddlewareOutcome(routes.identity)).admitted).toBe(true);

    // Platform getSession() returns 401 mid-session: cloudSession flips to
    // absent, but the local gateway keeps sessionStatus 'authenticated' (the
    // sole session authority, #35152 — asserted in auth-store.test.ts). So the
    // user is not evicted.
    useAuthStore.setState({
      cloudSession: "absent",
    });

    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
  });

  test("still redirects a logged-out platform user with no reachable assistant to login", async () => {
    isLocalClientMock.mockImplementation(() => false);
    hasAssistantsMock.mockImplementation(() => false);
    mockSelectedAssistant = undefined;
    mockGatewayTokenPresent = false;
    useAuthStore.setState({
      sessionStatus: "unauthenticated",
      user: null,
      cloudSession: "absent",
    });

    const outcome = await runMiddlewareOutcome("/assistant/identity");
    expect(outcome.admitted).toBe(false);
    if (!outcome.admitted) {
      expect(outcome.response.status).toBe(302);
      expect(outcome.response.headers.get("Location")).toBe(
        `${routes.remotePair}?returnTo=${encodeURIComponent("/assistant/identity")}`,
      );
    }
  });
});

describe("authMiddleware — hydration timeout", () => {
  test("a hung hydration degrades to a decision instead of re-entering the wait", async () => {
    isLocalClientMock.mockImplementation(() => false);
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      cloudSession: "present",
    });
    // Simulate consent/assistants fetches that hang: neither store ever
    // reports hydration, so both waits run out their (clamped) timeouts.
    const priorConsentHydrated = useOnboardingStore.getState().consentHydrated;
    const priorAssistantsHydrated =
      useResolvedAssistantsStore.getState().assistantsHydrated;
    useOnboardingStore.setState({ consentHydrated: false });
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: false,
    });

    try {
      // Must settle (the consent prefs are pinned current above, so with the
      // hydration flags forced after the timeout, requireAssistant lands on
      // the consented no-assistant branch) — pre-guard this recursed into the
      // identical wait forever.
      const res = await runMiddleware(routes.identity);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(routes.onboarding.hatching);
    } finally {
      useOnboardingStore.setState({ consentHydrated: priorConsentHydrated });
      useResolvedAssistantsStore.setState({
        assistantsHydrated: priorAssistantsHydrated,
      });
    }
  });

  // The research entry waits for consent to hydrate. Forcing the hydration flag
  // after the timeout leaves the consent flags at their boot `false`, so the
  // funnel's own gate would read a consented user as un-onboarded and evict
  // them into privacy — losing a paid return's markers, restarting a free
  // user's onboarding. It admits instead. The assistants list is hydrated here,
  // so the fail-open rests on the consent wait alone.
  test("admits a research funnel entry whose consent hydration hung", async () => {
    isLocalClientMock.mockImplementation(() => false);
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      cloudSession: "present",
    });
    // The boot state a cold deep link sees: nothing read back from the server
    // yet, and the fetch that would never reports.
    consentPrefs.tos = false;
    consentPrefs.privacy = false;
    const priorConsentHydrated = useOnboardingStore.getState().consentHydrated;
    useOnboardingStore.setState({ consentHydrated: false });
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: true,
    });

    try {
      const outcome = await runMiddlewareOutcome(researchFunnelEntry);
      expect(outcome.admitted).toBe(true);
    } finally {
      useOnboardingStore.setState({ consentHydrated: priorConsentHydrated });
    }
  });

  // Fail-open is scoped to the unhydrated read: consent that actually hydrated
  // on an unconsented user still bounces, carrying the funnel URL so the paid
  // markers survive the privacy screen.
  test("bounces the same entry once consent hydrates unconsented", async () => {
    isLocalClientMock.mockImplementation(() => false);
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      cloudSession: "present",
    });
    consentPrefs.tos = false;
    consentPrefs.privacy = false;
    const priorConsentHydrated = useOnboardingStore.getState().consentHydrated;
    useOnboardingStore.setState({ consentHydrated: true });
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: true,
    });

    try {
      // The bounce targets the app bundle's consent screen — a full-page
      // navigation, so the middleware admits and the page URL carries it.
      const outcome = await runMiddlewareOutcome(researchFunnelEntry);
      expect(outcome.admitted).toBe(true);
      expect(window.location.href.endsWith("/account/consent")).toBe(true);
    } finally {
      useOnboardingStore.setState({ consentHydrated: priorConsentHydrated });
    }
  });

  // The fail-open belongs to the consent wait alone. Consent that hydrates on
  // time reports a settled "not consented" whatever the assistants list is
  // doing, so a stalled list must not launder an unconsented user past the gate
  // and into a hatch they would be charged for.
  test("bounces an unconsented research entry when only the assistants list stalls", async () => {
    isLocalClientMock.mockImplementation(() => false);
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      cloudSession: "present",
    });
    consentPrefs.tos = false;
    consentPrefs.privacy = false;
    const priorConsentHydrated = useOnboardingStore.getState().consentHydrated;
    const priorAssistantsHydrated =
      useResolvedAssistantsStore.getState().assistantsHydrated;
    useOnboardingStore.setState({ consentHydrated: false });
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: false,
    });

    try {
      const pending = runMiddlewareOutcome(researchFunnelEntry);
      // Consent lands well inside its (clamped) wait; the assistants fetch
      // never reports, so only that second wait runs out.
      setTimeout(() => {
        useOnboardingStore.setState({ consentHydrated: true });
      }, 10);

      const outcome = await pending;
      expect(outcome.admitted).toBe(true);
      expect(window.location.href.endsWith("/account/consent")).toBe(true);
    } finally {
      useOnboardingStore.setState({ consentHydrated: priorConsentHydrated });
      useResolvedAssistantsStore.setState({
        assistantsHydrated: priorAssistantsHydrated,
      });
    }
  });

  // The consent wait runs first, so a fetch that reports just after it — while
  // the assistants wait is still running — leaves a settled "not consented" by
  // the time the guard recurses. Carrying the expired stall forward would fail
  // the gate open on a hydration that has since landed.
  test("bounces an unconsented research entry when consent lands during the assistants wait", async () => {
    isLocalClientMock.mockImplementation(() => false);
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      cloudSession: "present",
    });
    consentPrefs.tos = false;
    consentPrefs.privacy = false;
    const priorConsentHydrated = useOnboardingStore.getState().consentHydrated;
    const priorAssistantsHydrated =
      useResolvedAssistantsStore.getState().assistantsHydrated;
    useOnboardingStore.setState({ consentHydrated: false });
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: false,
    });

    try {
      const pending = runMiddlewareOutcome(researchFunnelEntry);
      // Past the (clamped) consent wait but inside the assistants one, which
      // never reports.
      setTimeout(() => {
        useOnboardingStore.setState({ consentHydrated: true });
      }, WAIT_TIMEOUT_CLAMP_MS + 30);

      const outcome = await pending;
      expect(outcome.admitted).toBe(true);
      expect(window.location.href.endsWith("/account/consent")).toBe(true);
    } finally {
      useOnboardingStore.setState({ consentHydrated: priorConsentHydrated });
      useResolvedAssistantsStore.setState({
        assistantsHydrated: priorAssistantsHydrated,
      });
    }
  });

  // Both fetches hang, so the consent wait times out on its own account and the
  // entry falls back to its unconditional admission.
  test("admits the research entry when both hydration waits stall", async () => {
    isLocalClientMock.mockImplementation(() => false);
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      cloudSession: "present",
    });
    consentPrefs.tos = false;
    consentPrefs.privacy = false;
    const priorConsentHydrated = useOnboardingStore.getState().consentHydrated;
    const priorAssistantsHydrated =
      useResolvedAssistantsStore.getState().assistantsHydrated;
    useOnboardingStore.setState({ consentHydrated: false });
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: false,
    });

    try {
      const outcome = await runMiddlewareOutcome(researchFunnelEntry);
      expect(outcome.admitted).toBe(true);
    } finally {
      useOnboardingStore.setState({ consentHydrated: priorConsentHydrated });
      useResolvedAssistantsStore.setState({
        assistantsHydrated: priorAssistantsHydrated,
      });
    }
  });
});
