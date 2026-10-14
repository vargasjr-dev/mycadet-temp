import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { AccountAuthSnapshot } from "./auth-state";
import { createAccountAuthReader } from "./auth-snapshot";

const initSession = mock(async () => {});
const refreshSession = mock(async () => true);
const logout = mock(async () => {});
const initial: AccountAuthSnapshot = {
  user: null,
  sessionStatus: "initializing",
  cloudSession: "unknown",
  initSession,
  refreshSession,
  logout,
};
let state = { ...initial, assistantPhase: "loading" };
const listeners = new Set<() => void>();
const source = createAccountAuthReader({
  getSnapshot: () => state,
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
});
mock.module("@app/stores/web-auth-source", () => ({
  accountAuthSource: source,
}));
const { useAuthStore, useIsAuthenticated, useIsSessionInitializing } =
  await import("./auth-store");
function update(patch: Partial<typeof state>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}
afterEach(() => {
  cleanup();
  state = { ...initial, assistantPhase: "loading" };
  mock.clearAllMocks();
});

test("assistant-only updates keep account snapshots stable and do not rerender account consumers", () => {
  const first = useAuthStore.getState();
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useAuthStore((state) => state.cloudSession);
  });
  const previousRenders = renders;
  act(() => update({ assistantPhase: "active" }));
  expect(useAuthStore.getState()).toBe(first);
  expect("assistantPhase" in useAuthStore.getState()).toBe(false);
  expect(renders).toBe(previousRenders);
  act(() => update({ cloudSession: "present" }));
  expect(result.current).toBe("present");
});
test("gateway authentication stays distinct from cloud-session presence", () => {
  const { result, unmount } = renderHook(() => ({
    authenticated: useIsAuthenticated(),
    initializing: useIsSessionInitializing(),
    cloud: useAuthStore((state) => state.cloudSession),
  }));
  expect(result.current.initializing).toBe(true);
  act(() => update({ sessionStatus: "authenticated", cloudSession: "absent" }));
  expect(result.current).toEqual({
    authenticated: true,
    initializing: false,
    cloud: "absent",
  });
  act(() => update({ sessionStatus: "unauthenticated" }));
  expect(result.current.authenticated).toBe(false);
  unmount();
  expect(listeners.size).toBe(0);
});
test("account actions retain the authoritative source's boot, refresh and logout behavior", async () => {
  const snapshot = useAuthStore.getState();
  await snapshot.initSession();
  expect(await snapshot.refreshSession()).toBe(true);
  await snapshot.logout();
  expect(initSession).toHaveBeenCalledTimes(1);
  expect(refreshSession).toHaveBeenCalledTimes(1);
  expect(logout).toHaveBeenCalledTimes(1);
});
