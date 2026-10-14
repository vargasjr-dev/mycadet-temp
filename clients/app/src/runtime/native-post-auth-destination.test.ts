import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  resolveNativePostAuthDestination,
  clearStaleNativeCheckoutStash,
} from "./native-post-auth-destination";
// Test the composed-client handoff as well as app's independent decision.
import {
  saveCheckoutIntent,
  clearCheckoutIntent,
  readCheckoutIntent,
  readPurchasedCheckoutIntent,
} from "@web/lib/billing/checkout-intent";

const checkout = { save: saveCheckoutIntent, clear: clearCheckoutIntent };
const resolve = (
  intent: string | undefined,
  returnTo: string | null,
  returningUser = false,
) =>
  resolveNativePostAuthDestination(intent, returnTo, {
    checkout,
    returningUser,
  });
beforeEach(clearCheckoutIntent);
afterEach(clearCheckoutIntent);

for (const path of ["hosting", "privacy", "research"]) {
  test(`returning users skip first-run ${path} but preserve a new-assistant walk`, () => {
    const firstRun = `/assistant/onboarding/${path}`;
    expect(resolve("login", firstRun, true)).toBe("/assistant");
    expect(resolve("signup", `${firstRun}?new_assistant=1`, true)).toBe(
      `${firstRun}?new_assistant=1`,
    );
    expect(readCheckoutIntent()).toBeNull();
  });
}
test("returning signup keeps paid checkout and no-return login keeps its null contract", () => {
  expect(resolve("signup", "/assistant/checkout?package=super", true)).toBe(
    "/assistant/checkout?package=super",
  );
  expect(readCheckoutIntent()).toBeNull();
  expect(resolve("login", null, true)).toBeNull();
  expect(resolve("signup", null, true)).toBe("/assistant");
});
test("fresh signup saves a marked custom intent for web's consent page", () => {
  expect(
    resolve("signup", "/assistant/checkout?storage_tier=s&machine_tier=large"),
  ).toBe("/assistant/onboarding/privacy");
  expect(readCheckoutIntent()).toMatchObject({
    kind: "custom",
    storageTier: "s",
    machineTier: "large",
    creditTier: null,
    resumeAfterOnboarding: true,
  });
  expect(readPurchasedCheckoutIntent()).toBeNull();
  clearStaleNativeCheckoutStash(
    "signup",
    "/assistant/onboarding/privacy",
    checkout,
  );
  expect(readCheckoutIntent()).not.toBeNull();
  clearStaleNativeCheckoutStash(
    "login",
    "/assistant/checkout?package=super",
    checkout,
  );
  expect(readCheckoutIntent()).not.toBeNull();
  clearStaleNativeCheckoutStash(undefined, "/assistant", checkout);
  expect(readCheckoutIntent()).toBeNull();
});
test("fresh login keeps its destination and null default", () => {
  expect(resolve("login", "/assistant/identity")).toBe("/assistant/identity");
  expect(resolve(undefined, null)).toBeNull();
  expect(resolve("signup", null)).toBe("/assistant/onboarding/privacy");
});
test("app's signup handoff reaches web even when sessionStorage is unavailable", () => {
  const getItem = sessionStorage.getItem;
  const setItem = sessionStorage.setItem;
  sessionStorage.getItem = () => {
    throw new Error("storage unavailable");
  };
  sessionStorage.setItem = () => {
    throw new Error("storage unavailable");
  };
  try {
    resolve("signup", "/assistant/checkout?package=super");
    expect(readCheckoutIntent()).toMatchObject({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
  } finally {
    sessionStorage.getItem = getItem;
    sessionStorage.setItem = setItem;
  }
});
