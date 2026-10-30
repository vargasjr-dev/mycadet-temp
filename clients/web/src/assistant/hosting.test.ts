import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useSyncExternalStore } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";

let injectedConfig: { remote?: string; assistantId?: string } | undefined = {
  remote: "local",
  assistantId: "asst-local",
};
const injectedConfigMock = mock(() => injectedConfig);
mock.module("@/lib/injected-config", () => ({
  readInjectedConfig: injectedConfigMock,
}));

let resolutionState: AssistantResolutionState = { kind: "loading" };
const resolutionListeners = new Set<() => void>();
function setLifecycle(assistantState: AssistantResolutionState) {
  act(() => {
    resolutionState = assistantState;
    for (const listener of resolutionListeners) {
      listener();
    }
  });
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
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  useActiveAssistantIsCloudHosted,
  useActiveAssistantIsSelfHosted,
  useActiveAssistantLifecycleIsLoading,
  useAssistantHosting,
} from "@/assistant/hosting";

/** Point the store's active pointer at an assistant id (or clear it). */
function setActiveAssistantId(id: string | null) {
  act(() => {
    useResolvedAssistantsStore.setState({ activeAssistantId: id });
  });
}

beforeEach(() => {
  injectedConfig = { remote: "local", assistantId: "asst-local" };
  injectedConfigMock.mockClear();
  setLifecycle({ kind: "loading" });
  useResolvedAssistantsStore.setState({
    activeAssistantId: null,
    assistants: [],
    assistantsHydrated: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("useAssistantHosting", () => {
  test('answers the lockfile entry\'s remote for an active assistant', () => {
    setLifecycle({ kind: "active" });
    setActiveAssistantId("asst-local");
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("local");
  });

  test('answers the entry remote even when the injected remote differs', () => {
    injectedConfig = { remote: "local", assistantId: "asst-local" };
    setLifecycle({ kind: "active" });
    setActiveAssistantId("asst-local");
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("local");
  });

  test('answers "cloud" for an active row with no lockfile entry', () => {
    // A row absent from the served lockfile exists only in the cloud-served
    // world — the cloud platform keeps no locally-synthesized entry.
    injectedConfig = { remote: "cloud" };
    setLifecycle({ kind: "active" });
    setActiveAssistantId("asst-platform");
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("cloud");
  });

  test("answers with the serving remote outside an active resolution", () => {
    injectedConfig = { remote: "apple-container", assistantId: "asst-local" };
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("apple-container");
  });

  test('falls back to "local" when nothing was injected', () => {
    injectedConfig = undefined;
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("local");
  });
});

describe("useActiveAssistantIsSelfHosted", () => {
  test("true for an active assistant whose lockfile remote is self-hosted", () => {
    injectedConfig = { remote: "docker", assistantId: "asst-local" };
    setLifecycle({ kind: "active" });
    setActiveAssistantId("asst-local");
    const { result } = renderHook(() => useActiveAssistantIsSelfHosted());
    expect(result.current).toBe(true);
  });

  test("false while loading and on a transport error", () => {
    const { result } = renderHook(() => useActiveAssistantIsSelfHosted());
    expect(result.current).toBe(false);
    setLifecycle({ kind: "error", message: "down", transient: true });
    expect(result.current).toBe(false);
  });

  test("false for a cloud-hosted assistant (no lockfile entry)", () => {
    injectedConfig = { remote: "cloud" };
    setLifecycle({ kind: "active" });
    setActiveAssistantId("asst-platform");
    const { result } = renderHook(() => useActiveAssistantIsSelfHosted());
    expect(result.current).toBe(false);
  });
});

describe("useActiveAssistantIsCloudHosted", () => {
  test("true only for an active assistant with no lockfile entry", () => {
    const { result } = renderHook(() => useActiveAssistantIsCloudHosted());
    expect(result.current).toBe(false);
    injectedConfig = { remote: "cloud" };
    setLifecycle({ kind: "active" });
    setActiveAssistantId("asst-platform");
    expect(result.current).toBe(true);
  });

  test("false for every other lifecycle state", () => {
    injectedConfig = { remote: "cloud" };
    const { result } = renderHook(() => useActiveAssistantIsCloudHosted());
    setLifecycle({ kind: "initializing" });
    expect(result.current).toBe(false);
    setLifecycle({ kind: "error", message: "down" });
    expect(result.current).toBe(false);
  });
});

describe("useActiveAssistantLifecycleIsLoading", () => {
  test("true for the transitional lifecycle states", () => {
    const { result } = renderHook(() => useActiveAssistantLifecycleIsLoading());
    expect(result.current).toBe(true);
    setLifecycle({ kind: "initializing" });
    expect(result.current).toBe(true);
    setLifecycle({ kind: "cleaning_up" });
    expect(result.current).toBe(true);
    setLifecycle({ kind: "active" });
    expect(result.current).toBe(false);
  });
});
