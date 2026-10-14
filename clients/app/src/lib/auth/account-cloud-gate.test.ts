import { expect, test } from "bun:test";
import { accountCloudGate } from "./account-cloud-gate";

const cases = [
  [false, false, "unknown", "pending"],
  [false, false, "absent", "disabled"],
  [false, false, "present", "full"],
  [false, true, "unknown", "pending"],
  [false, true, "absent", "disabled"],
  [false, true, "present", "full"],
  [true, false, "unknown", "pending"],
  [true, false, "absent", "disabled"],
  [true, false, "present", "full"],
  [true, true, "unknown", "gated"],
  [true, true, "absent", "gated"],
  [true, true, "present", "gated"],
] as const;
for (const [local, cloudDisabled, session, expected] of cases) {
  test(`account gate: local=${local}, cloudDisabled=${cloudDisabled}, session=${session}`, () => {
    expect(accountCloudGate({ local, cloudDisabled, session })).toBe(expected);
  });
}
