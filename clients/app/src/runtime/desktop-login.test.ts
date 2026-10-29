import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { isOAuthFlowInFlight } from "./oauth-flow-state";

import type { NativePostAuthContext } from "@app/runtime/native-post-auth-destination";
const calls: string[] = [];
let contextPending: Promise<NativePostAuthContext> | undefined;
let response: unknown = { sessionToken: "session-token" };
let available = true;
let returningUser = false;
const startOAuth = mock(async (_options: unknown): Promise<unknown> => {
  calls.push("host");
  return response;
});
const refreshSession = mock(async () => {
  calls.push("refresh");
  return true;
});
mock.module("@app/runtime/electron-bridge", () => ({
  getElectronBridge: () =>
    available ? { auth: { startOAuth } } : { auth: {} },
}));
mock.module("@app/stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ refreshSession }) },
}));
mock.module("@app/runtime/native-auth-context", () => ({
  nativeAuthContext: {
    read: async () => {
      calls.push("context");
      return (
        contextPending ?? {
          returningUser,
          checkout: { save: () => {}, clear: () => {} },
        }
      );
    },
  },
}));
const { startDesktopLogin } = await import("./desktop-login");
const originalLocation = Object.getOwnPropertyDescriptor(window, "location");
const location = { href: "" };
beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: location,
  });
  response = { sessionToken: "session-token" };
  available = true;
  returningUser = false;
  contextPending = undefined;
  calls.length = 0;
  location.href = "";
  mock.clearAllMocks();
});
afterEach(() => {
  if (originalLocation) {
    Object.defineProperty(window, "location", originalLocation);
  }
  expect(isOAuthFlowInFlight()).toBe(false);
});
test("desktop login refreshes the account before choosing the post-auth destination", async () => {
  refreshSession.mockImplementationOnce(async () => {
    expect(isOAuthFlowInFlight()).toBe(true);
    returningUser = true;
    calls.push("refresh");
    return true;
  });
  await startDesktopLogin({
    intent: "signup",
    returnTo: "/assistant/onboarding/privacy",
    loginHint: "person@example.com",
  });
  expect(startOAuth).toHaveBeenCalledWith({
    intent: "signup",
    loginHint: "person@example.com",
  });
  expect(calls).toEqual(["host", "refresh", "context"]);
  expect(location.href).toBe("/assistant");
});
test("host exchange keeps resume probes suspended until it completes", async () => {
  let resolve!: (value: unknown) => void;
  startOAuth.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = startDesktopLogin({ returnTo: "/assistant/identity" });
  expect(isOAuthFlowInFlight()).toBe(true);
  expect(refreshSession).not.toHaveBeenCalled();
  resolve({ sessionToken: "session-token" });
  await pending;
  expect(location.href).toBe("/assistant/identity");
});
test("missing host capability reports the desktop update error without starting OAuth", async () => {
  available = false;
  await expect(startDesktopLogin()).rejects.toMatchObject({
    code: "AUTH_ERROR",
    data: { authError: "desktop_update_required" },
  });
  expect(startOAuth).not.toHaveBeenCalled();
  expect(location.href).toBe("");
});
for (const invalid of [null, {}, { sessionToken: "" }, { sessionToken: 123 }]) {
  test(`invalid IPC session ${JSON.stringify(invalid)} cannot refresh or navigate`, async () => {
    response = invalid;
    await expect(startDesktopLogin()).rejects.toThrow("invalid session");
    expect(refreshSession).not.toHaveBeenCalled();
    expect(location.href).toBe("");
  });
}
test("host cancellation reaches the caller and clears the account OAuth scope", async () => {
  const cancelled = Object.assign(new Error("cancelled"), {
    code: "USER_CANCELLED",
  });
  startOAuth.mockRejectedValueOnce(cancelled);
  await expect(startDesktopLogin()).rejects.toBe(cancelled);
  expect(location.href).toBe("");
});
test("account refresh errors release OAuth without navigation", async () => {
  refreshSession.mockRejectedValueOnce(new Error("refresh failed"));
  await expect(startDesktopLogin()).rejects.toThrow("refresh failed");
  expect(location.href).toBe("");
});
test("untrusted returnTo falls back to assistant", async () => {
  await startDesktopLogin({ returnTo: "https://evil.example" });
  expect(location.href).toBe("/assistant");
});

test("desktop keeps OAuth guards active and waits for app facts before navigating", async () => {
  let resolve!: (value: NativePostAuthContext) => void;
  contextPending = new Promise((done) => {
    resolve = done;
  });
  const pending = startDesktopLogin({
    intent: "signup",
    returnTo: "/assistant/onboarding/privacy",
  });
  for (let tick = 0; tick < 10; tick++) {
    await Promise.resolve();
  }
  expect(calls).toContain("context");
  expect(location.href).toBe("");
  expect(isOAuthFlowInFlight()).toBe(true);
  resolve({ returningUser: true });
  await pending;
  expect(location.href).toBe("/assistant");
});
