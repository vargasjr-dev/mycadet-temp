import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useResolvedAssistantsStore, type ResolvedAssistant } from "@/stores/resolved-assistants-store";
import {
  useActiveAssistantIsCloudHosted,
  useActiveAssistantIsSelfHosted,
  useAssistantHosting,
} from "@/assistant/hosting";

function row(id: string, cloud?: string): ResolvedAssistant {
  return { id, ...(cloud ? { cloud } : {}) };
}

/** Point the store's active pointer at an assistant id (or clear it). */
function setActive(id: string | null, assistants: ResolvedAssistant[]) {
  act(() => {
    useResolvedAssistantsStore.setState({
      activeAssistantId: id,
      assistants,
      assistantsHydrated: true,
    });
  });
}

beforeEach(() => {
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
  test('reads the active row\'s lockfile remote', () => {
    setActive("asst-local", [row("asst-local", "local")]);
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("local");
  });

  test('answers "cloud" for a row absent from the lockfile', () => {
    // The projection normalizes no-entry rows to "cloud" — they exist only
    // in the cloud-served world.
    setActive("asst-platform", [row("asst-platform", "cloud")]);
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("cloud");
  });

  test('answers "cloud" with no active row at all', () => {
    const { result } = renderHook(() => useAssistantHosting());
    expect(result.current).toBe("cloud");
  });
});

describe("useActiveAssistantIsSelfHosted", () => {
  test("true for a self-hosted active row", () => {
    setActive("asst-local", [row("asst-local", "docker")]);
    const { result } = renderHook(() => useActiveAssistantIsSelfHosted());
    expect(result.current).toBe(true);
  });

  test("false for a cloud-hosted active row", () => {
    setActive("asst-platform", [row("asst-platform", "cloud")]);
    const { result } = renderHook(() => useActiveAssistantIsSelfHosted());
    expect(result.current).toBe(false);
  });
});

describe("useActiveAssistantIsCloudHosted", () => {
  test("true for a cloud active row", () => {
    setActive("asst-platform", [row("asst-platform", "cloud")]);
    const { result } = renderHook(() => useActiveAssistantIsCloudHosted());
    expect(result.current).toBe(true);
  });

  test("false for a self-hosted active row", () => {
    setActive("asst-local", [row("asst-local", "local")]);
    const { result } = renderHook(() => useActiveAssistantIsCloudHosted());
    expect(result.current).toBe(false);
  });
});
