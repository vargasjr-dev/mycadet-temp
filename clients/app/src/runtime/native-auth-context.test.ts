import { expect, mock, test } from "bun:test";
let returning = false;
mock.module("@app/assistant/returning-user", () => ({
  readReturningUser: async () => returning,
}));
const { nativeAuthContext } = await import("./native-auth-context");
test("native context reads app-owned assistant facts", async () => {
  expect(await nativeAuthContext.read()).toEqual({
    returningUser: false,
  });
  returning = true;
  expect(await nativeAuthContext.read()).toEqual({
    returningUser: true,
  });
});
