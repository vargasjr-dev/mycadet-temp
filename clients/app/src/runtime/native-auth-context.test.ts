import { expect, mock, test } from "bun:test";
let returning = false;
const checkout = { save: mock(() => {}), clear: mock(() => {}) };
const finish = mock(() => {});
const begin = mock(() => finish);
const prime = mock((_token: string) => {});
const wait = mock(async () => {});
mock.module("@app/assistant/returning-user", () => ({
  readReturningUser: async () => returning,
}));
mock.module("@app/lib/billing/checkout-intent-storage", () => ({
  checkoutHandoff: checkout,
}));
mock.module("@app/runtime/composed-account-session", () => ({
  composedAccountSession: {
    beginOAuth: begin,
    primeSessionToken: prime,
    waitSessionSettled: wait,
  },
}));
const { nativeAuthContext } = await import("./native-auth-context");
test("native context reads app-owned assistant facts and preserves checkout and reconciliation", async () => {
  expect(await nativeAuthContext.read()).toEqual({
    returningUser: false,
    checkout,
  });
  returning = true;
  expect(await nativeAuthContext.read()).toEqual({
    returningUser: true,
    checkout,
  });
  expect(nativeAuthContext.checkout).toBe(checkout);
  const complete = nativeAuthContext.beginComposedOAuth();
  nativeAuthContext.primeComposedSession("session-token");
  await nativeAuthContext.waitComposedSession();
  complete();
  expect(prime).toHaveBeenCalledWith("session-token");
  expect(wait).toHaveBeenCalledTimes(1);
  expect(finish).toHaveBeenCalledTimes(1);
});
