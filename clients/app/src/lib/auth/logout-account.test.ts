import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
let desktop = false;
let localHost = false;
const revoke = mock(async () => {});
const signOut = mock(async () => {});
const deleteBiometricToken = mock(async () => {});
const setMenuCloudSession = mock(async (_has: boolean) => {});
const fetchSpy = spyOn(globalThis, "fetch");
mock.module("@app/lib/auth/session-client", () => ({
  logoutAccountSession: revoke,
}));
mock.module("@app/runtime/electron-bridge", () => ({
  getElectronBridge: () => (desktop ? { auth: { signOut } } : undefined),
}));
mock.module("@app/runtime/local-host-transport", () => ({
  isLocalModeHostAvailable: () => localHost,
}));
mock.module("@app/runtime/native-biometric", () => ({ deleteBiometricToken }));
mock.module("@app/runtime/menu", () => ({ setMenuCloudSession }));
const { logoutAccount } = await import("./logout-account");
beforeEach(() => {
  desktop = false;
  localHost = false;
  mock.clearAllMocks();
  fetchSpy.mockResolvedValue(new Response(null));
});
afterAll(() => fetchSpy.mockRestore());
test("browser logout revokes the account without accessing an assistant or local host", async () => {
  await logoutAccount();
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(signOut).not.toHaveBeenCalled();
  expect(setMenuCloudSession).toHaveBeenCalledWith(false);
});
test("desktop credentials and biometrics are cleared even if account revocation or host signout fails", async () => {
  desktop = true;
  localHost = true;
  revoke.mockRejectedValueOnce(new Error("Cloud unavailable"));
  signOut.mockRejectedValueOnce(new Error("Host unavailable"));
  await expect(logoutAccount()).rejects.toThrow("Cloud unavailable");
  expect(signOut).toHaveBeenCalledTimes(1);
  expect(deleteBiometricToken).toHaveBeenCalledTimes(1);
  expect(setMenuCloudSession).toHaveBeenCalledWith(false);
  expect(fetchSpy).not.toHaveBeenCalled();
});
test("localhost logout clears the proxy token and tolerates an offline host", async () => {
  localHost = true;
  fetchSpy.mockRejectedValueOnce(new Error("Host offline"));
  await logoutAccount();
  expect(fetchSpy).toHaveBeenCalledWith("/v1/session", {
    method: "DELETE",
  });
  expect(deleteBiometricToken).toHaveBeenCalledTimes(1);
});
