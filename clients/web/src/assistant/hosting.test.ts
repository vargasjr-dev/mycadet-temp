import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

let injectedConfig: { remote?: string; assistantId?: string } | undefined = {
  remote: "local",
  assistantId: "asst-local",
};
const injectedConfigMock = mock(() => injectedConfig);
mock.module("@/lib/injected-config", () => ({
  readInjectedConfig: injectedConfigMock,
}));

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  useActiveAssistantIsCloudHosted,
  useActiveAssistantIsSelfHosted,
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
  test('answers "cloud" for a row with no lockfile entry', () => {
    // A row absent from the lockfile exists only in the cloud-served
    // world — the cloud platform keeps no locally-synthesized entry.
    setActiveAssistantId("asst-platform");
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("cloud");
  });

  test("the injected config no longer decides anything", () => {
    // The injected remote was the pre-resolution answer; there is no
    // pre-resolution window left, so even an apple-container stamp can't
    // turn a no-entry row local.
    injectedConfig = { remote: "apple-container", assistantId: "asst-local" };
    setActiveAssistantId("asst-platform");
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("cloud");
  });
});

describe("useActiveAssistantIsSelfHosted", () => {
  test("true for a self-hosted lockfile entry", () => {
    injectedConfig = { remote: "docker", assistantId: "asst-local" };
    setActiveAssistantId("asst-local");
    const { result } = renderHook(() => useActiveAssistantIsSelfHosted());
    expect(result.current).toBe(true);
  });

  test("false for a cloud-hosted assistant (no lockfile entry)", () => {
    setActiveAssistantId("asst-platform");
    const { result } = renderHook(() => useActiveAssistantIsSelfHosted());
    expect(result.current).toBe(false);
  });
});

describe("useActiveAssistantIsCloudHosted", () => {
  test("true for a cloud row with no lockfile entry", () => {
    setActiveAssistantId("asst-platform");
    const { result } = renderHook(() => useActiveAssistantIsCloudHosted());
    expect(result.current).toBe(true);
  });

  test("false for a self-hosted lockfile entry", () => {
    injectedConfig = { remote: "local", assistantId: "asst-local" };
    setActiveAssistantId("asst-local");
    const { result } = renderHook(() => useActiveAssistantIsCloudHosted());
    expect(result.current).toBe(false);
  });
});
