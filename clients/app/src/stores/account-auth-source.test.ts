import { afterEach, expect, mock, test } from "bun:test";
let native = true;
let oauthPending = false;
let resume: ((state: { isActive: boolean }) => void) | undefined;
const remove = mock(async () => {});
const addListener = mock(async (_name: string, callback: typeof resume) => {
  resume = callback;
  return { remove };
});
const getSession = mock(async () => ({
  ok: true,
  data: { user: { id: "cloud" } },
}));
const revokeSession = mock(async () => {});
mock.module("@capacitor/app", () => ({ App: { addListener } }));
mock.module("@app/runtime/native-platform", () => ({
  isNativePlatform: () => native,
}));
mock.module("@app/runtime/oauth-flow-state", () => ({
  isOAuthFlowInFlight: () => oauthPending,
}));
mock.module("@app/lib/auth/session-client", () => ({
  getSession,
}));
mock.module("@app/lib/auth/logout-account", () => ({
  logoutAccount: revokeSession,
}));
mock.module("@app/stores/account-user-snapshot", () => ({
  accountUserSnapshot: { read: () => null, write: () => {}, clear: () => {} },
}));
const { accountAuthSource, startAccountSessionListeners } =
  await import("./account-auth-source");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  native = true;
  oauthPending = false;
  mock.clearAllMocks();
});
test("resume listeners are shared, respect desktop OAuth and stop after the last reader leaves", async () => {
  const first = startAccountSessionListeners();
  const second = startAccountSessionListeners();
  expect(addListener).toHaveBeenCalledTimes(1);
  await settle();
  expect(getSession).toHaveBeenCalledTimes(1);
  oauthPending = true;
  window.dispatchEvent(new Event("online"));
  resume?.({ isActive: true });
  expect(getSession).toHaveBeenCalledTimes(1);
  oauthPending = false;
  resume?.({ isActive: false });
  expect(getSession).toHaveBeenCalledTimes(1);
  resume?.({ isActive: true });
  await settle();
  expect(getSession).toHaveBeenCalledTimes(2);
  first();
  await settle();
  expect(remove).not.toHaveBeenCalled();
  second();
  second();
  await settle();
  expect(remove).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event("online"));
  resume?.({ isActive: true });
  await settle();
  expect(getSession).toHaveBeenCalledTimes(2);
});
test("explicit account refresh and logout use account-owned requests", async () => {
  await accountAuthSource.getSnapshot().refreshSession();
  expect(getSession).toHaveBeenCalledTimes(1);
  expect(accountAuthSource.getSnapshot().cloudSession).toBe("present");
  await accountAuthSource.getSnapshot().logout();
  expect(revokeSession).toHaveBeenCalledTimes(1);
  expect(accountAuthSource.getSnapshot().cloudSession).toBe("absent");
});
