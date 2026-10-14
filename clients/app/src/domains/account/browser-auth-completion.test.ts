import { afterEach, beforeEach, expect, mock, test } from "bun:test";
let local = false;
let returningUser = false;
let hasAssistants = false;
const calls: string[] = [];
const refreshSession = mock(async () => {
  calls.push("session");
  return true;
});
const refresh = mock(async () => {
  calls.push("assistants");
});
const has = mock(async () => {
  calls.push("presence");
  return hasAssistants;
});
const save = mock((_value: unknown) => {});
mock.module("@app/lib/runtime-mode", () => ({ isLocalClient: () => local }));
mock.module("@app/domains/account/assistant-auth-handoff", () => ({
  assistantAuthHandoff: {
    refresh,
    hasAssistants: has,
    read: () => {
      calls.push("context");
      return { returningUser, checkout: { save, clear: () => {} } };
    },
  },
}));
const { completeBrowserAuthentication, navigatePostAuthDestination } =
  await import("./browser-auth-completion");
const args = {
  refreshSession,
  returnTo: null,
  fallback: "/assistant",
  authIntent: "signup" as const,
};
beforeEach(() => {
  local = returningUser = hasAssistants = false;
  calls.length = 0;
  mock.clearAllMocks();
});
test("completion reads returning-user facts after both session and assistant refresh", async () => {
  refresh.mockImplementationOnce(async () => {
    calls.push("assistants");
    returningUser = true;
  });
  expect(await completeBrowserAuthentication(args)).toEqual({
    destination: "/assistant",
    requiresFullPageNavigation: false,
  });
  expect(calls).toEqual(["session", "assistants", "context"]);
});
test("fresh signup preserves its checkout carry through completion", async () => {
  const post = await completeBrowserAuthentication({
    ...args,
    returnTo: "/assistant/checkout?package=super",
  });
  expect(post.destination).toBe("/assistant/onboarding/privacy");
  expect(save).toHaveBeenCalledWith({
    kind: "package",
    packageKey: "super",
    resumeAfterOnboarding: true,
  });
});
test("local callback without returnTo prefers an existing assistant", async () => {
  local = hasAssistants = true;
  expect(
    (
      await completeBrowserAuthentication({
        ...args,
        preferLocalAssistant: true,
      })
    ).destination,
  ).toBe("/assistant");
  expect(calls).toEqual(["session", "assistants", "presence"]);
});
test("local assistant presence does not override an explicit signup return", async () => {
  local = hasAssistants = true;
  expect(
    (
      await completeBrowserAuthentication({
        ...args,
        preferLocalAssistant: true,
        returnTo: "/assistant/checkout?package=super",
      })
    ).destination,
  ).toBe("/assistant/onboarding/privacy");
  expect(save).toHaveBeenCalledTimes(1);
});
test("signup completion has no local callback preference and conflict resolves as login", async () => {
  local = hasAssistants = true;
  expect((await completeBrowserAuthentication(args)).destination).toBe(
    "/assistant/onboarding/privacy",
  );
  expect(has).not.toHaveBeenCalled();
  expect(
    (
      await completeBrowserAuthentication({
        ...args,
        authIntent: "login",
        returnTo: "/assistant/checkout?package=super",
      })
    ).destination,
  ).toBe("/assistant/checkout?package=super");
});
test("failed reconciliation reaches the callback error path without reading stale facts", async () => {
  refresh.mockRejectedValueOnce(new Error("refresh failed"));
  await expect(completeBrowserAuthentication(args)).rejects.toThrow(
    "refresh failed",
  );
  expect(calls).toEqual(["session"]);
});
const originalLocation = Object.getOwnPropertyDescriptor(window, "location");
afterEach(() => {
  if (originalLocation) {
    Object.defineProperty(window, "location", originalLocation);
  }
});
test("external completion hard-navigates while SPA completion respects replace", () => {
  const location = { href: "" };
  Object.defineProperty(window, "location", {
    configurable: true,
    value: location,
  });
  const navigate = mock(() => {});
  navigatePostAuthDestination(
    {
      destination: "/accounts/cli/callback?port=54321",
      requiresFullPageNavigation: true,
    },
    navigate,
    true,
  );
  expect(location.href).toBe("/accounts/cli/callback?port=54321");
  expect(navigate).not.toHaveBeenCalled();
  navigatePostAuthDestination(
    { destination: "/assistant", requiresFullPageNavigation: false },
    navigate,
    true,
  );
  expect(navigate).toHaveBeenCalledWith("/assistant", { replace: true });
  navigatePostAuthDestination(
    {
      destination: "/assistant/onboarding/privacy",
      requiresFullPageNavigation: false,
    },
    navigate,
  );
  expect(navigate).toHaveBeenCalledWith("/assistant/onboarding/privacy", {
    replace: false,
  });
});
