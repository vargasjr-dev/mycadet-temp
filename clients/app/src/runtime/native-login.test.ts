import { afterEach, beforeEach, expect, mock, test } from "bun:test";
const startAuth = mock(async (_options: unknown) => ({
  sessionToken: "native-token",
}));
const getSession = mock(async () => ({
  ok: true,
  data: { user: { id: "user" } },
}));
const markSpent = mock(() => {});
let biometric = false;
const storeToken = mock(async (_token: string) => false);
const disableBiometric = mock((_enabled: boolean) => {});
mock.module("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android" },
  registerPlugin: () => ({ startAuth }),
}));
mock.module("@app/runtime/native-platform", () => ({
  isNativePlatform: () => true,
}));
mock.module("@app/lib/auth/session-client", () => ({ getSession }));
mock.module("@app/runtime/native-attribution", () => ({
  resolveNativeAttribution: async () => ({ utm_source: "play" }),
}));
mock.module("@app/runtime/install-referrer", () => ({
  markInstallReferrerSpent: markSpent,
}));
mock.module("@app/runtime/native-biometric", () => ({
  isBiometricEnabled: () => biometric,
  storeBiometricToken: storeToken,
  setBiometricEnabled: disableBiometric,
}));
mock.module("@app/runtime/native-auth-context", () => ({
  nativeAuthContext: { checkout: {} },
}));
const { startNativeLogin } = await import("./native-login");
const originalLocation = Object.getOwnPropertyDescriptor(window, "location");
const originalCookie = Object.getOwnPropertyDescriptor(document, "cookie");
const cookies: string[] = [];
const location = { protocol: "https:", host: "www.mycadet.ai", href: "" };
beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: location,
  });
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => "",
    set: (value) => cookies.push(value),
  });
  location.href = "";
  cookies.length = 0;
  biometric = false;
  mock.clearAllMocks();
});
afterEach(() => {
  if (originalLocation)
    Object.defineProperty(window, "location", originalLocation);
  if (originalCookie) Object.defineProperty(document, "cookie", originalCookie);
  else Reflect.deleteProperty(document, "cookie");
});
test("native login waits for the session cookie before navigation and spends attribution", async () => {
  getSession.mockResolvedValueOnce({ ok: false, data: { user: { id: "" } } });
  await startNativeLogin({
    returnTo: "/assistant/identity",
    intent: "login",
    loginHint: "person@example.com",
  });
  expect(startAuth).toHaveBeenCalledWith({
    baseURL: "https://www.mycadet.ai",
    postAuthDestination: "/assistant/identity",
    intent: "login",
    loginHint: "person@example.com",
    attribution: { utm_source: "play" },
  });
  expect(cookies).toHaveLength(2);
  expect(cookies[0]).toContain("sessionid=native-token;");
  expect(cookies[1]).toContain("__Secure-sessionid=native-token;");
  expect(getSession).toHaveBeenCalledTimes(2);
  expect(markSpent).toHaveBeenCalledTimes(1);
  expect(storeToken).not.toHaveBeenCalled();
  expect(location.href).toBe("/assistant/identity");
});
test("unsafe destinations fall back to assistant and failed Android secure storage disables biometrics", async () => {
  biometric = true;
  await startNativeLogin({ returnTo: "https://evil.example" });
  expect(location.href).toBe("/assistant");
  expect(storeToken).toHaveBeenCalledWith("native-token");
  expect(disableBiometric).toHaveBeenCalledWith(false);
});
