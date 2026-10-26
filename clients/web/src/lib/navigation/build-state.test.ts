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
});

afterEach(() => {
  useAuthStore.setState(initialAuthState, true);
});

describe("buildNavigationState — the onboarding fork's inputs", () => {
  test("cloudSession is surfaced verbatim for the onboarding fork", () => {
    // The route fork's onboarding wait keys off cloudSession === 'unknown';
    // the field is surfaced verbatim from the store.
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
