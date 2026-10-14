import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createAccountSessionSource } from "./account-session-source";
import type { AllauthResult, SessionSchema } from "@app/lib/auth/auth-response";
import type { z } from "zod";

type Result = AllauthResult<z.infer<typeof SessionSchema>>;
let resolve!: (result: Result) => void;
const getSession = mock(
  () =>
    new Promise<Result>((done) => {
      resolve = done;
    }),
);
const logout = mock(async () => {});
function makeSource() {
  return createAccountSessionSource({
    getSession,
    snapshot: { read: () => null, write: () => {}, clear: () => {} },
    synchronizeAssistant: async () => true,
    logout,
  });
}
let source = makeSource();
const subscriptions = new Set<() => void>();
mock.module("@app/stores/account-auth-source", () => ({
  accountAuthSource: {
    getSnapshot: () => source.getSnapshot(),
    subscribe: (listener: () => void) => {
      subscriptions.add(listener);
      const unsubscribe = source.subscribe(listener);
      return () => {
        subscriptions.delete(listener);
        unsubscribe();
      };
    },
  },
  startAccountSessionListeners: () => () => {},
}));
const { useAuthStore, useIsAuthenticated, useIsSessionInitializing } =
  await import("./auth-store");
beforeEach(() => {
  source = makeSource();
  mock.clearAllMocks();
});
afterEach(cleanup);

test("account hooks share initialization and observe their own cloud user", async () => {
  const initial = useAuthStore.getState();
  const { result, unmount } = renderHook(() => ({
    authenticated: useIsAuthenticated(),
    initializing: useIsSessionInitializing(),
    user: useAuthStore.use.user(),
  }));
  expect(result.current).toEqual({
    authenticated: false,
    initializing: true,
    user: null,
  });
  expect(getSession).toHaveBeenCalledTimes(1);
  expect(useAuthStore.getState()).toBe(initial);
  await act(async () => {
    resolve({ ok: true, data: { user: { id: "cloud", first_name: "Cloud" } } });
  });
  expect(result.current.authenticated).toBe(true);
  expect(result.current.initializing).toBe(false);
  expect(result.current.user).toMatchObject({
    kind: "cloud",
    id: "cloud",
    firstName: "Cloud",
  });
  expect("assistantPhase" in useAuthStore.getState()).toBe(false);
  unmount();
  expect(subscriptions.size).toBe(0);
});
test("rejected cloud sessions show signed-out account UI and logout actions retain cleanup", async () => {
  const { result } = renderHook(() => ({
    authenticated: useIsAuthenticated(),
    cloud: useAuthStore((state) => state.cloudSession),
    logout: useAuthStore.use.logout(),
  }));
  await act(async () => {
    resolve({ ok: false, status: 401, errors: [] });
  });
  expect(result.current).toMatchObject({
    authenticated: false,
    cloud: "absent",
  });
  await act(async () => {
    await result.current.logout();
  });
  expect(logout).toHaveBeenCalledTimes(1);
});
