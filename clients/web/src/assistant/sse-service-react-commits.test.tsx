import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "zustand";

import type { AssistantEventEnvelope } from "@mycadet/assistant-api";
import { makeEnvelope } from "@/assistant/sse-service.test-helper";

// Registered before the bus is imported so the bus binds to the mock.
const captureErrorMock = mock(() => {});
mock.module("@/lib/error-reporting/capture-error", () => ({
  captureError: captureErrorMock,
}));

const eventBus = await import("@/lib/event-bus");

type EventHandler = (envelope: AssistantEventEnvelope) => void;

let activeOnEvent: EventHandler | null = null;
mock.module("@/lib/streaming/stream-transport", () => ({
  subscribeEvents: (_assistantId: string, onEvent: EventHandler) => {
    activeOnEvent = onEvent;
    return { cancel: () => {} };
  },
}));

const { sseService } = await import("@/assistant/sse-service");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let container: HTMLElement | null = null;
let detach: (() => void) | null = null;

beforeEach(() => {
  eventBus.__resetForTesting();
  captureErrorMock.mockClear();
  activeOnEvent = null;
});

afterEach(() => {
  detach?.();
  detach = null;
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

// React counts a commit toward its nested-update limit when it finishes with
// an update still pending. A store write per envelope, each in its own
// microtask, is one synchronous commit per envelope inside a single task; the
// effect below leaves a default-priority update pending that cannot render
// until that task ends, so the count climbs with every envelope and React
// throws `Maximum update depth exceeded` from the store write after the 50th.
// The bus catches a throwing handler and reports it through `captureError`,
// which is what this asserts never happens.
test("a long run of envelopes reaches React as one commit and never trips the nested-update limit", async () => {
  const useSeqStore = create<{ seq: number }>()(() => ({ seq: 0 }));
  let renders = 0;
  function View() {
    const seq = useSeqStore((s) => s.seq);
    const [mirrored, setMirrored] = useState(0);
    useEffect(() => {
      setMirrored(seq);
    }, [seq]);
    renders += 1;
    return (
      <p>
        {seq}:{mirrored}
      </p>
    );
  }

  const rendered = () => container?.textContent ?? "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<View />);
  // Wait for the mount's two commits instead of trusting a fixed sleep:
  // under CI's 2-core contention a 20ms budget can expire before the first
  // commit lands, which would pollute the batched-commit count below.
  for (let deadline = Date.now() + 10_000; rendered() !== "0:0"; ) {
    if (Date.now() > deadline) {throw new Error("View never mounted");}
    await sleep(25);
  }

  eventBus.subscribe("sse.event", (envelope) => {
    useSeqStore.setState({ seq: envelope.seq ?? 0 });
  });
  detach = sseService.attach("asst-1");
  const rendersBefore = renders;

  for (let seq = 1; seq <= 300; seq += 1) {
    activeOnEvent!(makeEnvelope(seq));
    await Promise.resolve();
  }
  // Same headroom for the final commit + its effect follow-up.
  for (let deadline = Date.now() + 10_000; rendered() !== "300:300"; ) {
    if (Date.now() > deadline) {break;}
    await sleep(25);
  }

  expect(captureErrorMock).not.toHaveBeenCalled();
  expect(rendered()).toBe("300:300");
  // One commit for the run and one for the effect's follow-up.
  expect(renders - rendersBefore).toBeLessThanOrEqual(3);
});
