import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { lifecycleService } from "@/assistant/lifecycle-service";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { ActiveAssistantGate } from "./active-assistant-gate";

function renderGate() {
  return render(
    <MemoryRouter>
      <ActiveAssistantGate />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useAssistantLifecycleStore.setState({ assistantState: { kind: "loading" } });
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("ActiveAssistantGate", () => {
  test("a lifecycle error renders the honest error panel — not an eternal connecting spinner", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
    useAssistantLifecycleStore.setState({
      assistantState: {
        kind: "error",
        message: "hatch_failed: firecracker never came up",
      },
    });

    renderGate();

    expect(screen.getByText("We couldn't reach your assistant")).toBeDefined();
    expect(
      screen.getByText("hatch_failed: firecracker never came up"),
    ).toBeDefined();
    expect(screen.queryByText("Connecting to your assistant…")).toBeNull();
  });

  test("the error panel's retry re-arms the lifecycle service", () => {
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "error", message: "unreachable" },
    });
    const retry = lifecycleService.retryAssistant.bind(lifecycleService);
    let calls = 0;
    lifecycleService.retryAssistant = () => {
      calls += 1;
    };

    renderGate();
    fireEvent.click(screen.getByText("Try again"));

    expect(calls).toBe(1);
    lifecycleService.retryAssistant = retry;
  });

  test("an unresolved lifecycle still renders the connecting placeholder", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });

    renderGate();

    expect(screen.getByText("Connecting to your assistant…")).toBeDefined();
  });
});
