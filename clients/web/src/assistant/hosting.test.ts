import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useSyncExternalStore } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";

let injectedRemote: string | undefined = "local";
const injectedConfigMock = mock(() =>
  injectedRemote === undefined ? undefined : { remote: injectedRemote },
);
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
import {
  useActiveAssistantIsCloudHosted,
  useActiveAssistantIsSelfHosted,
  useActiveAssistantLifecycleIsLoading,
  useAssistantHosting,
} from "@/assistant/hosting";

beforeEach(() => {
  injectedRemote = "local";
  injectedConfigMock.mockClear();
  setLifecycle({ kind: "loading" });
});

afterEach(() => {
  cleanup();
});

describe("useActiveAssistantIsSelfHosted", () => {
  test("true for a server-projected self-hosted assistant", () => {
    setLifecycle({ kind: "self_hosted" });
    const { result } = renderHook(() => useActiveAssistantIsSelfHosted());
    expect(result.current).toBe(true);
  });

  test("true for the gateway-auth short-circuit (active, local)", () => {
    setLifecycle({ kind: "active", isLocal: true });
    const { result } = renderHook(() => useActiveAssistantIsSelfHosted());
    expect(result.current).toBe(true);
  });

  test("false while loading and on a transport error", () => {
    const { result } = renderHook(() => useActiveAssistantIsSelfHosted());
    expect(result.current).toBe(false);
    setLifecycle({ kind: "error", message: "down", transient: true });
    expect(result.current).toBe(false);
  });

  test("false for a positively cloud-hosted assistant", () => {
    setLifecycle({ kind: "active", isLocal: false });
    const { result } = renderHook(() => useActiveAssistantIsSelfHosted());
    expect(result.current).toBe(false);
  });
});

describe("useActiveAssistantIsCloudHosted", () => {
  test("true only for a positively resolved cloud-hosted assistant", () => {
    const { result } = renderHook(() => useActiveAssistantIsCloudHosted());
    expect(result.current).toBe(false);
    setLifecycle({ kind: "active", isLocal: false });
    expect(result.current).toBe(true);
  });

  test("false for every other lifecycle state", () => {
    const { result } = renderHook(() => useActiveAssistantIsCloudHosted());
    setLifecycle({ kind: "self_hosted" });
    expect(result.current).toBe(false);
    setLifecycle({ kind: "active", isLocal: true });
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
    setLifecycle({ kind: "active", isLocal: false });
    expect(result.current).toBe(false);
  });
});

describe("useAssistantHosting", () => {
  test('answers "cloud" for a resolved cloud-hosted assistant', () => {
    setLifecycle({ kind: "active", isLocal: false });
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("cloud");
  });

  test("answers with the serving remote for a self-hosted assistant", () => {
    injectedRemote = "docker";
    setLifecycle({ kind: "active", isLocal: true });
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("docker");
  });

  test("answers with the serving remote without inventing a resolving arm", () => {
    injectedRemote = "apple-container";
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("apple-container");
  });

  test('falls back to "local" when nothing was injected', () => {
    injectedRemote = undefined;
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("local");
  });
});
