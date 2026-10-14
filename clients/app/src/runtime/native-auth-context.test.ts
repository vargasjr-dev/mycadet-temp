import { expect, mock, test } from "bun:test";
let returning = false;
const checkout = { save: mock(() => {}), clear: mock(() => {}) };
const finish = mock(() => {});
const begin = mock(() => finish);
const prime = mock((_token: string) => {});
const wait = mock(async () => {});
mock.module("@web/domains/account/login-flow", () => ({
  nativeAuthReturningUser: () => returning,
  nativeCheckoutHandoff: checkout,
}));
mock.module("@web/stores/auth-store", () => ({
  beginCloudAccountOAuth: begin,
  primeCloudAccountSessionToken: prime,
  whenCloudSessionSettled: wait,
}));
const { nativeAuthContext } = await import("./native-auth-context");
test("handoff reads current assistant facts and preserves the shared stash writer", async () => {
  expect(nativeAuthContext.read()).toEqual({ returningUser: false, checkout });
  returning = true;
  expect(nativeAuthContext.read()).toEqual({ returningUser: true, checkout });
  expect(nativeAuthContext.checkout).toBe(checkout);
  const complete = nativeAuthContext.beginComposedOAuth();
  nativeAuthContext.primeComposedSession("session-token");
  await nativeAuthContext.waitComposedSession();
  complete();
  expect(prime).toHaveBeenCalledWith("session-token");
  expect(wait).toHaveBeenCalledTimes(1);
  expect(finish).toHaveBeenCalledTimes(1);
});
