import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Spread the real `@/lib/local-mode` so every other export the dependency graph
// pulls in stays available; override only the hosting-mode flags build-state
// branches on.
let mockIsLocalClient = true;
let mockIsCloudRemote = false;
let mockGatewaySessionLive = false;

const localModeActual = await import("@/lib/local-mode");
mock.module("@/lib/local-mode", () => ({
  ...localModeActual,
  isLocalClient: () => mockIsLocalClient,
  isCadetCloudRemote: () => mockIsCloudRemote,
  isGatewaySessionLive: () => mockGatewaySessionLive,
}));

// The guard's session questions are answered by the boot resolution via
// `bootResolutionFact` — mocked at that boundary here; the fact's own
// mapping is pinned in queries.test.ts through the real chain.
let mockBootFact = { settled: true, authenticated: true };
mock.module("@/assistant/queries", () => ({
  bootResolutionFact: () => mockBootFact,
}));

const { buildNavigationState } = await import("./build-state");
const { useAuthStore } = await import("@/stores/auth-store");
const { useOrganizationStore } = await import("@/stores/organization-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { clearSelectedAssistantId, writeSelectedAssistantId } =
  await import("@/assistant/selected-assistant-storage");

const initialAuthState = useAuthStore.getState();

beforeEach(() => {
  mockIsLocalClient = true;
  mockIsCloudRemote = false;
  mockGatewaySessionLive = false;
  useAuthStore.setState(initialAuthState, true);
  useOrganizationStore.setState({
    currentOrganizationId: null,
    persistedOrganizationId: null,
  });
  globalThis.sessionStorage?.clear();
  useResolvedAssistantsStore.setState({
    assistants: [],
    activeAssistantId: null,
  });
  clearSelectedAssistantId();
  mockBootFact = { settled: true, authenticated: true };
});

afterEach(() => {
  useAuthStore.setState(initialAuthState, true);
});

describe("buildNavigationState — the session answers come from the boot resolution", () => {
  test("a settled, live boot resolution is admitted", () => {
    mockBootFact = { settled: true, authenticated: true };

    const state = buildNavigationState();
    expect(state.sessionSettled).toBe(true);
    expect(state.isAuthenticated).toBe(true);
  });

  test("a settled rejection is not admitted", () => {
    mockBootFact = { settled: true, authenticated: false };

    const state = buildNavigationState();
    expect(state.sessionSettled).toBe(true);
    expect(state.isAuthenticated).toBe(false);
  });

  test("an unsettled boot resolution is neither settled nor admitted", () => {
    mockBootFact = { settled: false, authenticated: false };

    const state = buildNavigationState();
    expect(state.sessionSettled).toBe(false);
    expect(state.isAuthenticated).toBe(false);
  });

  test("cloudSession is surfaced verbatim for the onboarding fork", () => {
    // The route fork's onboarding wait keys off cloudSession === 'unknown';
    // surfacing isAuthenticated must not disturb that field.
    useAuthStore.setState({ cloudSession: "unknown" });

    expect(buildNavigationState().cloudSession).toBe("unknown");
  });
});

describe("buildNavigationState — onboarding scoping", () => {
  const FRESH = new Date().toISOString();
  const WEEK_OLD = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const row = (id: string, hatchedAt: string) => ({
    id,
    hatchedAt,
    isLocal: false,
    isCloudHosted: true,
    isPaired: false,
  });

  test("false on both when no assistant is a week old", () => {
    useResolvedAssistantsStore.setState({
      assistants: [row("asst-fresh", FRESH)],
    });
    writeSelectedAssistantId("asst-fresh");

    const state = buildNavigationState();
    expect(state.userHasOnboardedAssistant).toBe(false);
    expect(state.selectedAssistantOnboarded).toBe(false);
  });

  test("true on both when the selected assistant is a week old", () => {
    useResolvedAssistantsStore.setState({
      assistants: [row("asst-old", WEEK_OLD)],
    });
    writeSelectedAssistantId("asst-old");

    const state = buildNavigationState();
    expect(state.userHasOnboardedAssistant).toBe(true);
    expect(state.selectedAssistantOnboarded).toBe(true);
  });

  // The chooser loop: a week-old sibling must not answer for a fresh
  // selection, or every new-assistant walk is bounced back to the chooser.
  test("a week-old sibling does not make a fresh selection onboarded", () => {
    useResolvedAssistantsStore.setState({
      assistants: [row("asst-old", WEEK_OLD), row("asst-fresh", FRESH)],
    });
    writeSelectedAssistantId("asst-fresh");

    const state = buildNavigationState();
    expect(state.userHasOnboardedAssistant).toBe(true);
    expect(state.selectedAssistantOnboarded).toBe(false);
  });

  test("selectedAssistantOnboarded is false with nothing selected", () => {
    useResolvedAssistantsStore.setState({
      assistants: [row("asst-old", WEEK_OLD)],
    });
    clearSelectedAssistantId();

    expect(buildNavigationState().selectedAssistantOnboarded).toBe(false);
  });
});
