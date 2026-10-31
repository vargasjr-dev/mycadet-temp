import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Spread the real `@/lib/local-mode` so every other export the dependency graph
// pulls in stays available; override only the hosting-mode flags build-state
// branches on.
let mockIsLocalClient = true;
let mockIsCloudRemote = false;

const localModeActual = await import("@/lib/local-mode");
mock.module("@/lib/local-mode", () => ({
  ...localModeActual,
  isLocalClient: () => mockIsLocalClient,
  isCadetCloudRemote: () => mockIsCloudRemote,
}));

const { buildNavigationState } = await import("./build-state");
const { useResolvedAssistantStore } =
  await import("@/stores/resolved-assistant-store");

beforeEach(() => {
  mockIsLocalClient = true;
  mockIsCloudRemote = false;
  globalThis.sessionStorage?.clear();
  useResolvedAssistantStore.getState().setAssistant(null);
});

afterEach(() => {
  useResolvedAssistantStore.getState().setAssistant(null);
});

describe("buildNavigationState — onboarding scoping", () => {
  const FRESH = new Date().toISOString();
  const WEEK_OLD = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const entry = (assistantId: string, hatchedAt: string) => ({
    cloud: "cloud" as const,
    assistantId,
    hatchedAt,
  });

  test("false on both when the assistant is fresh", () => {
    useResolvedAssistantStore.getState().setAssistant(entry("asst", FRESH));

    const state = buildNavigationState();
    expect(state.userHasOnboardedAssistant).toBe(false);
    expect(state.selectedAssistantOnboarded).toBe(false);
  });

  test("true on both when the assistant is a week old", () => {
    useResolvedAssistantStore.getState().setAssistant(entry("asst", WEEK_OLD));

    const state = buildNavigationState();
    expect(state.userHasOnboardedAssistant).toBe(true);
    expect(state.selectedAssistantOnboarded).toBe(true);
  });

  test("false on both when nothing is served yet", () => {
    const state = buildNavigationState();
    expect(state.hasAssistants).toBe(false);
    expect(state.userHasOnboardedAssistant).toBe(false);
    expect(state.selectedAssistantOnboarded).toBe(false);
  });

  test("hasAssistants answers the served entry", () => {
    useResolvedAssistantStore.getState().setAssistant(entry("asst", FRESH));

    expect(buildNavigationState().hasAssistants).toBe(true);
  });
});
