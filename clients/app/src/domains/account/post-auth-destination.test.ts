import { expect, test } from "bun:test";
import { resolvePostAuthDestination } from "./post-auth-destination";
import { routes } from "@app/utils/routes";

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
test("untrusted redirects fall back and provider import signups preserve the cloud funnel", () => {
  expect(resolve("https://other.example.com").destination).toBe(
    routes.assistant,
  );
  expect(resolve("//other.example.com").destination).toBe(routes.assistant);
  expect(resolve("/import?agent=example", "signup")).toEqual({
    destination: "/import?agent=example",
    requiresFullPageNavigation: true,
  });
});
test("first-time signup routes through consent", () => {
  expect(
    resolve("/assistant/identity", "signup").destination,
  ).toBe(routes.onboarding.privacy);
});
test("returning users skip first-run pages but keep new-assistant work", () => {
  expect(resolve(routes.onboarding.privacy, "signup", true).destination).toBe(
    routes.assistant,
  );
  expect(resolve(routes.onboarding.research, "login", true).destination).toBe(
    routes.assistant,
  );
  const destination = `${routes.onboarding.research}?new_assistant=1`;
  expect(resolve(destination, "signup", true).destination).toBe(destination);
});
