import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CloudSessionAnswer } from "@/stores/auth-store";
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

// The middleware consumes the cloud-session probe through
// `whenCloudSessionProbed`. The tests hand it a controlled promise: resolved
// fixtures decide instantly, a never-resolving one is the in-flight probe.
let probeAnswer: Promise<CloudSessionAnswer> = new Promise(() => {});
mock.module("@/stores/auth-store", () => ({
  whenCloudSessionProbed: (): Promise<CloudSessionAnswer> => probeAnswer,
}));

// The guard re-runs itself through the router when a timed-out probe reports
// late; the assertion is on the re-run being armed, not on routing.
const revalidateMock = mock(() => {});
mock.module("@/routes", () => ({
  router: {
    revalidate: (): Promise<void> => {
      revalidateMock();
      return Promise.resolve();
    },
  },
}));

const {
  authMiddleware,
  __setProbeWaitTimeoutForTesting,
  __resetProbeRevalidationForTesting,
} = await import("./auth-middleware");
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

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

/** A probe that is still in flight, with its future answer in hand. */
function probeInFlight(): {
  settle: (answer: CloudSessionAnswer) => void;
} {
  let settle!: (answer: CloudSessionAnswer) => void;
  probeAnswer = new Promise((resolve) => {
    settle = resolve;
  });
  return { settle };
}

function probeSettlesWith(answer: CloudSessionAnswer): void {
  probeAnswer = Promise.resolve(answer);
}

beforeEach(() => {
  isLocalClientMock.mockImplementation(() => true);
  hasAssistantsMock.mockImplementation(() => false);
  mockSelectedAssistant = undefined;
  mockGatewayTokenPresent = false;
  revalidateMock.mockClear();
  probeSettlesWith("absent");
  __setProbeWaitTimeoutForTesting(5_000);
  __resetProbeRevalidationForTesting();
  useResolvedAssistantsStore.setState({
    assistants: [],
    activeAssistantId: null,
  });
});

afterEach(async () => {
  await tick();
});

describe("authMiddleware — local-mode onboarding fork", () => {
  test("waits for the cloud-session probe before choosing hosting vs welcome", async () => {
    const { settle } = probeInFlight();

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
    settle("present");
    await pending;

    expect(settled!.admitted).toBe(true);
    expect(window.location.href.endsWith(routes.onboarding.hosting)).toBe(true);
  });

  test("admits a resolved session with no platform session — the app bundle owns the welcome fork", async () => {
    // The local front door (welcome) moved into the app bundle (#523): web
    // never hosts it, so an authenticated local user whose cloud session is
    // absent is admitted here and the shell steers the onboarding fork.
    probeSettlesWith("absent");

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
    probeAnswer = new Promise(() => {});
    __setProbeWaitTimeoutForTesting(50);

    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
    expect(window.location.href.endsWith(routes.welcome)).toBe(true);
  });

  test("a late probe result re-runs the guard instead of being lost", async () => {
    const { settle } = probeInFlight();
    __setProbeWaitTimeoutForTesting(50);

    await runMiddlewareOutcome(routes.identity);
    // The wait timed out: the re-run is armed but has not fired.
    await tick();
    expect(revalidateMock).not.toHaveBeenCalled();

    // The probe lands late; the armed re-run fires.
    settle("present");
    await tick();
    await tick();
    expect(revalidateMock).toHaveBeenCalled();
  });

  test("routes to hosting when a resolved platform session exists", async () => {
    probeSettlesWith("present");

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
    probeSettlesWith("absent");

    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
  });

  test("research proceeds without waiting for the probe, web consent, or assistant hydration", async () => {
    isLocalClientMock.mockImplementation(() => false);
    // Still in flight: the middleware must not await it on this plane.
    probeInFlight();
    useResolvedAssistantsStore.setState({ assistants: [] });
    const href = window.location.href;
    const outcome = await runMiddlewareOutcome(
      `${routes.onboarding.research}?hosting=cadet-cloud`,
    );
    expect(outcome.admitted).toBe(true);
    expect(window.location.href).toBe(href);
  });
});
