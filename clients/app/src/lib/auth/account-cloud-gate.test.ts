import { expect, test } from "bun:test";
import { accountCloudGate } from "./account-cloud-gate";

const cases = [
  ["unknown", "pending"],
  ["absent", "disabled"],
  ["present", "full"],
] as const;
for (const [session, expected] of cases) {
  test(`account gate: session=${session}`, () => {
    expect(accountCloudGate({ session })).toBe(expected);
  });
}
