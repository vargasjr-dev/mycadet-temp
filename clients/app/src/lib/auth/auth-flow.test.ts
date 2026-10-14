import type { NativePostAuthContext } from "@app/runtime/native-post-auth-destination";
import { afterEach, expect, mock, test } from "bun:test";
let contextPending: Promise<NativePostAuthContext> | undefined;
let native = false;
let electron = false;
let local = false;
let platformLocal = false;
const provider = mock(async () => {});
const loopback = mock(async () => {});
const nativeFlow = mock(async () => {});
const mobileLogin = mock(async (_options: unknown) => {});
mock.module("@app/runtime/native-login", () => ({
  startNativeLogin: mobileLogin,
}));
mock.module("@app/runtime/native-platform", () => ({
  isNativePlatform: () => native,
}));
mock.module("@app/runtime/electron-bridge", () => ({
  getElectronBridge: () => (electron ? { platform: "electron" } : undefined),
}));
mock.module("@app/lib/runtime-mode", () => ({ isLocalClient: () => local }));
mock.module("@app/lib/auth/loopback-auth", () => ({
  isPlatformLocal: () => platformLocal,
  startLoopbackAuth: loopback,
}));
mock.module("@app/lib/auth/provider-redirect", () => ({
  startProviderRedirect: provider,
}));
mock.module("@app/runtime/desktop-login", () => ({
  startDesktopLogin: nativeFlow,
}));
mock.module("@app/runtime/native-auth-context", () => ({
  nativeAuthContext: {
    read: async () =>
      contextPending ?? {
        returningUser: false,
        checkout: { save: () => {}, clear: () => {} },
      },
  },
}));
const { startAuthFlow } = await import("./auth-flow");
afterEach(() => {
  native = electron = local = platformLocal = false;
  contextPending = undefined;
  provider.mockClear();
  loopback.mockClear();
  nativeFlow.mockClear();
  mobileLogin.mockClear();
});
const options = {
  returnTo: "/assistant/checkout?package=super",
  intent: "signup" as const,
  loginHint: "person@example.com",
  attribution: { utm_source: "campaign" },
};

test("cloud browser forwards callback and provider options to the local redirect", async () => {
  await startAuthFlow("workos", "/account/provider/callback", options);
  expect(provider).toHaveBeenCalledWith(
    "workos",
    "/account/provider/callback",
    options,
  );
  expect(nativeFlow).not.toHaveBeenCalled();
});
test("standalone localhost uses loopback while a local platform uses provider redirect", async () => {
  local = true;
  await startAuthFlow("workos", "/account/provider/callback", options);
  expect(loopback).toHaveBeenCalledWith(options.returnTo, { intent: "signup" });
  expect(provider).not.toHaveBeenCalled();
  platformLocal = true;
  await startAuthFlow("workos", "/account/provider/callback", options);
  expect(provider).toHaveBeenCalledTimes(1);
});
for (const host of ["native", "electron"]) {
  test(`${host} preserves its native destination and session handoff contract`, async () => {
    native = host === "native";
    electron = host === "electron";
    local = true;
    await startAuthFlow("workos", "/account/provider/callback", options);
    if (native) {
      expect(mobileLogin).toHaveBeenCalledWith({
        returnTo: "/assistant/onboarding/privacy",
        loginHint: options.loginHint,
        intent: options.intent,
        attribution: options.attribution,
      });
      expect(nativeFlow).not.toHaveBeenCalled();
    } else {
      expect(nativeFlow).toHaveBeenCalledWith(options);
      expect(mobileLogin).not.toHaveBeenCalled();
    }
    expect(provider).not.toHaveBeenCalled();
    expect(loopback).not.toHaveBeenCalled();
  });
}

test("native auth dismissal is routine while other failures reach the caller", async () => {
  native = true;
  mobileLogin.mockRejectedValueOnce(
    Object.assign(new Error("dismissed"), { code: "USER_CANCELLED" }),
  );
  await startAuthFlow("workos", "/account/provider/callback", options);
  mobileLogin.mockRejectedValueOnce(new Error("exchange failed"));
  await expect(
    startAuthFlow("workos", "/account/provider/callback", options),
  ).rejects.toThrow("exchange failed");
});

test("mobile waits for app facts before opening native auth and preserves returning-user signup", async () => {
  native = true;
  let resolve!: (value: NativePostAuthContext) => void;
  contextPending = new Promise((done) => {
    resolve = done;
  });
  const pending = startAuthFlow("workos", "/account/provider/callback", {
    intent: "signup",
    returnTo: "/assistant/onboarding/privacy",
  });
  expect(mobileLogin).not.toHaveBeenCalled();
  resolve({
    returningUser: true,
    checkout: { save: () => {}, clear: () => {} },
  });
  await pending;
  expect(mobileLogin).toHaveBeenCalledWith({
    returnTo: "/assistant",
    intent: "signup",
    loginHint: undefined,
    attribution: undefined,
  });
});
