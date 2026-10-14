import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
let session: "unknown" | "absent" | "present" = "unknown";
mock.module("@app/lib/auth/account-session", () => ({
  useAccountCloudSession: () => session,
}));
mock.module("@app/lib/runtime-mode", () => ({ isLocalClient: () => false }));
const { useAccountCloudGate } = await import("./use-account-cloud-gate");
afterEach(() => {
  cleanup();
  session = "unknown";
});
const delay = () => new Promise((resolve) => setTimeout(resolve, 25));
test("a stalled probe times out, a confirmed session wins, and a new pending window gets a fresh deadline", async () => {
  const { result, rerender } = renderHook(() => useAccountCloudGate(10));
  expect(result.current).toBe("pending");
  await act(async () => {
    await delay();
  });
  expect(result.current).toBe("disabled");
  session = "present";
  rerender();
  expect(result.current).toBe("full");
  session = "unknown";
  rerender();
  expect(result.current).toBe("pending");
  await act(async () => {
    await delay();
  });
  expect(result.current).toBe("disabled");
});
test("settling as absent cancels the pending timeout", async () => {
  const { result, rerender } = renderHook(() => useAccountCloudGate(10));
  session = "absent";
  rerender();
  expect(result.current).toBe("disabled");
  await act(async () => {
    await delay();
  });
  session = "present";
  rerender();
  expect(result.current).toBe("full");
});
