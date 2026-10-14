import { afterEach, expect, mock, test } from "bun:test";
import {
  composedAccountSession,
  installComposedAccountSession,
  type ComposedAccountSessionBridge,
} from "./composed-account-session";
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});
function setup() {
  let logoutListener: (() => () => void) | undefined;
  const unsubscribe = mock(() => {
    logoutListener = undefined;
  });
  const finishOAuth = mock(() => {});
  const bridge: ComposedAccountSessionBridge = {
    refresh: mock(async () => true),
    logout: mock(async (revoke) => {
      const finish = logoutListener?.();
      try {
        await revoke();
      } finally {
        finish?.();
      }
    }),
    beginOAuth: mock(() => finishOAuth),
    isOAuthActive: () => true,
    primeSessionToken: mock((_token: string) => {}),
    waitSessionSettled: mock(async () => {}),
    subscribeLogout: (listener) => {
      logoutListener = listener;
      return unsubscribe;
    },
  };
  cleanup = installComposedAccountSession(bridge);
  return {
    bridge,
    unsubscribe,
    finishOAuth,
    beginLogout: () => logoutListener?.(),
  };
}
test("account requests and native operations work without a Web bridge", async () => {
  const revoke = mock(async () => {});
  await composedAccountSession.refresh();
  await composedAccountSession.logout(revoke);
  composedAccountSession.beginOAuth()();
  composedAccountSession.primeSessionToken("session-token");
  await composedAccountSession.waitSessionSettled();
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(composedAccountSession.isOAuthActive()).toBe(false);
});
test("the installed assistant session receives account refresh, revocation, and native OAuth coordination", async () => {
  const { bridge, finishOAuth } = setup();
  const revoke = mock(async () => {});
  await composedAccountSession.refresh();
  await composedAccountSession.logout(revoke);
  const finish = composedAccountSession.beginOAuth();
  composedAccountSession.primeSessionToken("session-token");
  await composedAccountSession.waitSessionSettled();
  finish();
  expect(bridge.refresh).toHaveBeenCalledTimes(1);
  expect(bridge.logout).toHaveBeenCalledWith(revoke);
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(bridge.primeSessionToken).toHaveBeenCalledWith("session-token");
  expect(bridge.waitSessionSettled).toHaveBeenCalledTimes(1);
  expect(finishOAuth).toHaveBeenCalledTimes(1);
  expect(composedAccountSession.isOAuthActive()).toBe(true);
});
test("logout listeners registered before composition retain their scopes and finish once", () => {
  const finish = mock(() => {});
  const begin = mock(() => finish);
  const stop = composedAccountSession.subscribeLogout(begin);
  const { beginLogout } = setup();
  const end = beginLogout();
  expect(begin).toHaveBeenCalledTimes(1);
  stop();
  end?.();
  end?.();
  expect(finish).toHaveBeenCalledTimes(1);
  beginLogout()?.();
  expect(begin).toHaveBeenCalledTimes(1);
});
test("replacement disconnects the old session and its stale disposer cannot disconnect the new one", () => {
  const first = setup();
  const stopFirst = cleanup!;
  const second = setup();
  expect(first.unsubscribe).toHaveBeenCalledTimes(1);
  stopFirst();
  expect(second.unsubscribe).not.toHaveBeenCalled();
  expect(composedAccountSession.isOAuthActive()).toBe(true);
  cleanup?.();
  cleanup?.();
  expect(second.unsubscribe).toHaveBeenCalledTimes(1);
  expect(composedAccountSession.isOAuthActive()).toBe(false);
});

test("reinstalling the same bridge preserves the new registration when the old disposer runs", () => {
  const first = setup();
  const stale = cleanup!;
  cleanup = installComposedAccountSession(first.bridge);
  stale();
  expect(first.unsubscribe).toHaveBeenCalledTimes(1);
  expect(composedAccountSession.isOAuthActive()).toBe(true);
  cleanup();
  expect(first.unsubscribe).toHaveBeenCalledTimes(2);
  expect(composedAccountSession.isOAuthActive()).toBe(false);
});
