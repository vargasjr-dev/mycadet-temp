import { expect, mock, test } from "bun:test";
let returning = false;
const checkout = { save: mock(() => {}), clear: mock(() => {}) };
mock.module("@app/assistant/returning-user", () => ({
  readReturningUser: async () => returning,
}));
mock.module("@app/lib/billing/checkout-intent-storage", () => ({
  checkoutHandoff: checkout,
}));
const { nativeAuthContext } = await import("./native-auth-context");
test("native context reads app-owned assistant facts and preserves checkout", async () => {
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
});
