import { expect, test } from "bun:test";
import { accountCloudGate } from "./account-cloud-gate";

const cases = [
  ["initializing", "pending"],
  ["unauthenticated", "disabled"],
  ["authenticated", "full"],
] as const;
for (const [sessionStatus, expected] of cases) {
  test(`account gate: sessionStatus=${sessionStatus}`, () => {
    expect(accountCloudGate({ sessionStatus })).toBe(expected);
  });
}
