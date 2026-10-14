import { expect, mock, test } from "bun:test";
import type { ComposedAccountSessionBridge } from "./composed-account-session";
const refresh = mock(async () => true);
const revoke = mock(async () => {});
const logout = mock(
  async (options: { cloudAccount: { revokeSession(): Promise<void> } }) => {
    await options.cloudAccount.revokeSession();
  },
);
const finish = mock(() => {});
const begin = mock(() => finish);
const prime = mock((_token: string) => {});
const wait = mock(async () => {});
const unsubscribe = mock(() => {});
mock.module("@/stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ refreshSession: refresh, logout }) },
  beginCloudAccountOAuth: begin,
  isCloudAccountOAuthInFlight: () => true,
  primeCloudAccountSessionToken: prime,
  whenCloudSessionSettled: wait,
  subscribeCloudAccountLogout: () => unsubscribe,
}));
const { setupComposedAccountSession } =
  await import("./composed-account-session");
test("composition registers Web's assistant cleanup while account revocation stays supplied by app", async () => {
  let composedAccountSession!: ComposedAccountSessionBridge;
  const disconnect = mock(() => {});
  const stop = setupComposedAccountSession((bridge) => {
    composedAccountSession = bridge;
    return disconnect;
  });
  try {
    await composedAccountSession.refresh();
    await composedAccountSession.logout(revoke);
    const removeListener = composedAccountSession.subscribeLogout(
      () => () => {},
    );
    removeListener();
    const end = composedAccountSession.beginOAuth();
    composedAccountSession.primeSessionToken("session-token");
    await composedAccountSession.waitSessionSettled();
    end();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledWith({
      cloudAccount: { revokeSession: revoke },
    });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(prime).toHaveBeenCalledWith("session-token");
    expect(wait).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(composedAccountSession.isOAuthActive()).toBe(true);
  } finally {
    stop();
  }
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(1);
});
