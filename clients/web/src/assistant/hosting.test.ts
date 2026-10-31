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

import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";
import {
  useActiveAssistantIsCloudHosted,
  useActiveAssistantIsSelfHosted,
  useAssistantHosting,
} from "@/assistant/hosting";

/** Stamp (or clear) the served assistant. */
function setServedEntry(entry: LockfileAssistant | null) {
  act(() => {
    useResolvedAssistantStore.getState().setAssistant(entry);
  });
}

beforeEach(() => {
  injectedConfig = { remote: "local", assistantId: "asst-local" };
  injectedConfigMock.mockClear();
  useResolvedAssistantStore.getState().setAssistant(null);
});

afterEach(() => {
  cleanup();
});

describe("useAssistantHosting", () => {
  test("answers the served entry's cloud field", () => {
    setServedEntry({ cloud: "cloud", assistantId: "asst-platform" });
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("cloud");
  });

  test("answers a self-hosted entry's own topology", () => {
    setServedEntry({ cloud: "local", assistantId: "asst-local", port: 7830 });
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("local");
  });

  test("the injected config no longer decides anything", () => {
    // The injected remote was the pre-resolution answer; the served entry
    // carries the fact now — even an apple-container stamp can't turn a
    // cloud-projected assistant local.
    injectedConfig = { remote: "apple-container", assistantId: "asst-local" };
    setServedEntry({ cloud: "cloud", assistantId: "asst-platform" });
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("cloud");
  });

  test("an unstamped surface reads cloud-hosted (the pre-stamp fallback)", () => {
    setServedEntry(null);
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("cloud");
  });
});

describe("useActiveAssistantIsSelfHosted", () => {
  test("true for a self-hosted entry", () => {
    injectedConfig = { remote: "docker", assistantId: "asst-local" };
    setServedEntry({ cloud: "local", assistantId: "asst-local", port: 7830 });
    const { result } = renderHook(() => useActiveAssistantIsSelfHosted());
    expect(result.current).toBe(true);
  });

  test("false for a cloud-hosted assistant", () => {
    setServedEntry({ cloud: "cloud", assistantId: "asst-platform" });
    const { result } = renderHook(() => useActiveAssistantIsSelfHosted());
    expect(result.current).toBe(false);
  });
});

describe("useActiveAssistantIsCloudHosted", () => {
  test("true for a cloud-projected entry", () => {
    setServedEntry({ cloud: "cloud", assistantId: "asst-platform" });
    const { result } = renderHook(() => useActiveAssistantIsCloudHosted());
    expect(result.current).toBe(true);
  });

  test("false for a self-hosted entry", () => {
    injectedConfig = { remote: "local", assistantId: "asst-local" };
    setServedEntry({ cloud: "local", assistantId: "asst-local", port: 7830 });
    const { result } = renderHook(() => useActiveAssistantIsCloudHosted());
    expect(result.current).toBe(false);
  });
});
