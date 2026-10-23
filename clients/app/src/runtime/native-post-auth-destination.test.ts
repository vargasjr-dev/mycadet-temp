import { expect, test } from "bun:test";
import { resolveNativePostAuthDestination } from "./native-post-auth-destination";

const resolve = (
  intent: string | undefined,
  returnTo: string | null,
  returningUser = false,
) =>
  resolveNativePostAuthDestination(intent, returnTo, {
    returningUser,
  });

// Hosting moved to the app bundle — its funnel returnTo names the app path.
for (const [path, firstRunBase] of [
  ["hosting", "/account/onboarding/hosting"],
  ["privacy", "/assistant/onboarding/privacy"],
  ["research", "/assistant/onboarding/research"],
] as const) {
  test(`returning users skip first-run ${path} but preserve a new-assistant walk`, () => {
    const firstRun = firstRunBase;
    expect(resolve("login", firstRun, true)).toBe("/assistant");
    expect(resolve("signup", `${firstRun}?new_assistant=1`, true)).toBe(
      `${firstRun}?new_assistant=1`,
    );
  });
}
test("no-return login keeps its null contract; a returning signup lands in the app", () => {
  expect(resolve("login", null, true)).toBeNull();
  expect(resolve("signup", null, true)).toBe("/assistant");
});
test("a first-run signup routes through consent; a login keeps its returnTo", () => {
  expect(resolve("signup", "/assistant/identity")).toBe(
    "/assistant/onboarding/privacy",
  );
  expect(resolve("login", "/assistant/identity")).toBe("/assistant/identity");
});
