import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
let sessionStatus: "initializing" | "authenticated" | "unauthenticated" =
  "initializing";
mock.module("@app/stores/auth-store", () => ({
  useAuthStore: (selector: (state: { sessionStatus: typeof sessionStatus }) => unknown) =>
    selector({ sessionStatus }),
}));
const { useAccountCloudGate } = await import("./use-account-cloud-gate");
afterEach(() => {
  cleanup();
  sessionStatus = "initializing";
});
const delay = () => new Promise((resolve) => setTimeout(resolve, 25));
test("a stalled probe times out, a confirmed session wins, and a new pending window gets a fresh deadline", async () => {
  const { result, rerender } = renderHook(() => useAccountCloudGate(10));
  expect(result.current).toBe("pending");
  await act(async () => {
    await delay();
  });
  expect(result.current).toBe("disabled");
  sessionStatus = "authenticated";
  rerender();
  expect(result.current).toBe("full");
  sessionStatus = "initializing";
  rerender();
  expect(result.current).toBe("pending");
  await act(async () => {
    await delay();
  });
  expect(result.current).toBe("disabled");
});
test("settling as unauthenticated cancels the pending timeout", async () => {
  const { result, rerender } = renderHook(() => useAccountCloudGate(10));
  sessionStatus = "unauthenticated";
  rerender();
  expect(result.current).toBe("disabled");
  await act(async () => {
    await delay();
  });
  sessionStatus = "authenticated";
  rerender();
  expect(result.current).toBe("full");
});
