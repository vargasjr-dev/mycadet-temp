import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { sseService } from "@/assistant/sse-service";
import { useEventBusInit } from "@/hooks/use-event-bus-init";
import { __resetForTesting } from "@/lib/event-bus";

const detachMock = mock(() => {});
const attachSpy = spyOn(sseService, "attach").mockImplementation(
  () => detachMock,
);

beforeEach(() => {
  __resetForTesting();
  attachSpy.mockClear();
  detachMock.mockClear();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

afterAll(() => {
  attachSpy.mockRestore();
});

// The hook is a thin React adapter — wire signal sources at mount,
// call `sseService.attach` when an assistant is active. React's own
// `useEffect` semantics cover unmount, dep-change, and cleanup
// ordering; testing those is testing the framework. The only
// application-level invariant left is the gate: don't attach without
// a resolved id.
describe("useEventBusInit — attach gating", () => {
  test("does not attach when assistantId is null", () => {
    renderHook(() =>
      useEventBusInit({ assistantId: null }),
    );
    expect(attachSpy).not.toHaveBeenCalled();
  });

  test("attaches sseService with the resolved id when the assistant becomes active", () => {
    renderHook(() =>
      useEventBusInit({ assistantId: "asst-1" }),
    );
    expect(attachSpy).toHaveBeenCalledTimes(1);
    expect(attachSpy.mock.calls[0]![0]).toBe("asst-1");
  });
});
