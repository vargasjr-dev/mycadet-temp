import { afterEach, expect, spyOn, test } from "bun:test";
import { resolvePostAuthDestination } from "./post-auth-destination";
import {
  CHECKOUT_INTENT_STORAGE_KEY,
  checkoutHandoff,
} from "@app/lib/billing/checkout-intent-storage";
import { routes } from "@app/utils/routes";

afterEach(() => {
  checkoutHandoff.clear();
});
function resolve(
  returnTo: string | null,
  authIntent: "login" | "signup" = "login",
  returningUser = false,
) {
  return resolvePostAuthDestination({
    returnTo,
    fallback: routes.assistant,
    authIntent,
    returningUser,
  });
}
test("untrusted redirects fall back and provider import signups preserve the platform funnel", () => {
  expect(resolve("https://other.example.com").destination).toBe(
    routes.assistant,
  );
  expect(resolve("//other.example.com").destination).toBe(routes.assistant);
  expect(resolve("/import?agent=example", "signup")).toEqual({
    destination: "/import?agent=example",
    requiresFullPageNavigation: true,
  });
});
test("first-time signup carries checkout into assistant consent", () => {
  expect(
    resolve("/assistant/checkout?package=super", "signup").destination,
  ).toBe(routes.onboarding.privacy);
  expect(
    JSON.parse(sessionStorage.getItem(CHECKOUT_INTENT_STORAGE_KEY)!),
  ).toMatchObject({
    kind: "package",
    packageKey: "super",
    resumeAfterOnboarding: true,
  });
});
test("returning users skip first-run pages but keep paid and new-assistant work", () => {
  expect(resolve(routes.onboarding.privacy, "signup", true).destination).toBe(
    routes.assistant,
  );
  expect(resolve(routes.onboarding.research, "login", true).destination).toBe(
    routes.assistant,
  );
  for (const query of [
    "?new_assistant=1",
    "?post_checkout=1&hosting=cadet-cloud",
  ]) {
    const destination = `${routes.onboarding.research}${query}`;
    expect(resolve(destination, "signup", true).destination).toBe(destination);
  }
  expect(
    resolve("/assistant/checkout?package=super", "signup", true).destination,
  ).toBe("/assistant/checkout?package=super");
  expect(sessionStorage.getItem(CHECKOUT_INTENT_STORAGE_KEY)).toBeNull();
});
test("non-checkout auth clears abandoned signup checkout", () => {
  checkoutHandoff.save({
    kind: "package",
    packageKey: "super",
    resumeAfterOnboarding: true,
  });
  resolve(routes.assistant);
  expect(sessionStorage.getItem(CHECKOUT_INTENT_STORAGE_KEY)).toBeNull();
});
test("storage-disabled signup still notifies assistant consent and a later login clears it", () => {
  const notifications: unknown[] = [];
  const listener = (event: Event) => {
    if (event instanceof CustomEvent) {
      notifications.push(event.detail);
    }
  };
  const write = spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new Error("Unavailable");
  });
  const remove = spyOn(sessionStorage, "removeItem").mockImplementation(() => {
    throw new Error("Unavailable");
  });
  window.addEventListener("cadet:pref-changed", listener);
  try {
    expect(
      resolve(
        "/assistant/checkout?storage_tier=s&machine_tier=medium",
        "signup",
      ).destination,
    ).toBe(routes.onboarding.privacy);
    resolve(routes.assistant);
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toEqual({
      key: CHECKOUT_INTENT_STORAGE_KEY,
      value: "",
    });
  } finally {
    write.mockRestore();
    remove.mockRestore();
    window.removeEventListener("cadet:pref-changed", listener);
  }
});
