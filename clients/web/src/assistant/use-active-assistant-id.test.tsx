import { afterEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";

import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";
import { useActiveAssistantId } from "./use-active-assistant-id";
import { useSetupLocalAssistant } from "@/testing/use-setup-local-assistant";

afterEach(() => {
  useResolvedAssistantStore.getState().setAssistant(null);
});

describe("useActiveAssistantId", () => {
  test("returns the active id when the gate has resolved", () => {
    useSetupLocalAssistant("asst-1");
    const { result } = renderHook(() => useActiveAssistantId());
    expect(result.current).toBe("asst-1");
  });

  test("throws when no assistant is resolved (the store is empty)", () => {
    expect(() => {
      renderHook(() => useActiveAssistantId());
    }).toThrow(/no resolved assistant/);
  });
});
