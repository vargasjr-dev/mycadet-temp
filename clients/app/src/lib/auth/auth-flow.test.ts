import { afterEach, expect, mock, test } from "bun:test";
let native = false;
let electron = false;
let local = false;
let platformLocal = false;
const provider = mock(async () => {});
const loopback = mock(async () => {});
const nativeFlow = mock(async () => {});
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
mock.module("@web/runtime/native-auth", () => ({ startAuthFlow: nativeFlow }));
const { startAuthFlow } = await import("./auth-flow");
afterEach(() => {
  native = electron = local = platformLocal = false;
  provider.mockClear();
  loopback.mockClear();
  nativeFlow.mockClear();
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
  test(`${host} keeps session and destination reconciliation in the existing native flow`, async () => {
    native = host === "native";
    electron = host === "electron";
    local = true;
    await startAuthFlow("workos", "/account/provider/callback", options);
    expect(nativeFlow).toHaveBeenCalledWith(
      "workos",
      "/account/provider/callback",
      options,
    );
    expect(provider).not.toHaveBeenCalled();
    expect(loopback).not.toHaveBeenCalled();
  });
}
