import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { AssistantResolutionState } from "@/assistant/types";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

let resolutionState: AssistantResolutionState = { kind: "loading" };
let refetchCalls = 0;

mock.module("@/assistant/queries", () => ({
  useAssistantResolution: () => ({
    state: resolutionState,
    result: undefined,
    selectedCloudAssistantId: null,
    refetch: () => {
      refetchCalls += 1;
    },
  }),
  useAssistantBootResolution: () => ({
    state: resolutionState,
    result: undefined,
    selectedCloudAssistantId: null,
    refetch: () => {
      refetchCalls += 1;
    },
  }),
}));

const { ActiveAssistantGate } = await import("./active-assistant-gate");

function renderGate() {
  return render(
    <MemoryRouter>
      <ActiveAssistantGate />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  resolutionState = { kind: "loading" };
  refetchCalls = 0;
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("ActiveAssistantGate", () => {
  test("a resolution error renders the honest error panel — not an eternal connecting spinner", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
    resolutionState = {
      kind: "error",
      message: "hatch_failed: firecracker never came up",
    };

    renderGate();

    expect(screen.getByText("We couldn't reach your assistant")).toBeDefined();
    expect(
      screen.getByText("hatch_failed: firecracker never came up"),
    ).toBeDefined();
    expect(screen.queryByText("Connecting to your assistant…")).toBeNull();
  });

  test("the error panel's retry refetches the resolution", () => {
    resolutionState = { kind: "error", message: "unreachable" };

    renderGate();
    fireEvent.click(screen.getByText("Try again"));

    expect(refetchCalls).toBe(1);
  });

  test("an unresolved resolution still renders the connecting placeholder", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });

    renderGate();

    expect(screen.getByText("Connecting to your assistant…")).toBeDefined();
  });
});
