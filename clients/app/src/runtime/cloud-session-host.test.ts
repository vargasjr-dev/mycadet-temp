import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { registerLocalCloudSession } from "@app/runtime/cloud-session-host";
import { readInjectedConfig } from "@app/lib/injected-config";

const originalConfig = Object.getOwnPropertyDescriptor(
  window,
  "__CADET_CONFIG__",
);
const originalBridge = Object.getOwnPropertyDescriptor(window, "cadet");
const requests = spyOn(globalThis, "fetch");

function setConfig(value: unknown) {
  Object.defineProperty(window, "__CADET_CONFIG__", {
    configurable: true,
    writable: true,
    value,
  });
}

afterEach(() => {
  requests.mockReset();
  if (originalConfig)
    Object.defineProperty(window, "__CADET_CONFIG__", originalConfig);
  else Reflect.deleteProperty(window, "__CADET_CONFIG__");
  if (originalBridge) Object.defineProperty(window, "cadet", originalBridge);
  else Reflect.deleteProperty(window, "cadet");
});

// The isolated file owns the fetch spy and restores it after its last test.
afterAll(() => requests.mockRestore());

test("plain and remote browser hosts never receive a session token", async () => {
  Reflect.deleteProperty(window, "cadet");
  for (const config of [
    undefined,
    { remote: "cloud" },
    { remote: "docker" },
    { remote: "custom" },
  ]) {
    setConfig(config);
    expect(await registerLocalCloudSession("session123")).toBe(false);
  }
  expect(requests).not.toHaveBeenCalled();
});

test("local browser hosts receive the same cloud-session POST", async () => {
  Reflect.deleteProperty(window, "cadet");
  setConfig({ remote: "local", baseUrl: "https://mycadet.ai" });
  requests.mockResolvedValue(new Response('{"ok":true}'));
  expect(readInjectedConfig()?.baseUrl).toBe("https://mycadet.ai");
  expect(await registerLocalCloudSession("session123")).toBe(true);
  expect(requests).toHaveBeenCalledWith("/v1/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"token":"session123"}',
  });
});

test("Electron exposes the host endpoint without injected browser config", async () => {
  setConfig(undefined);
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: { platform: "electron" },
  });
  requests.mockResolvedValue(new Response('{"ok":true}'));
  expect(await registerLocalCloudSession("session123")).toBe(true);
});

test("unreachable, invalid JSON, and invalid command results fail without throwing", async () => {
  setConfig({ remote: "local" });
  requests.mockRejectedValueOnce(new Error("offline"));
  expect(await registerLocalCloudSession("session123")).toBe(false);
  for (const body of ["not JSON", '{"ok":false}', '{"ok":"true"}', "{}"]) {
    requests.mockResolvedValueOnce(new Response(body));
    expect(await registerLocalCloudSession("session123")).toBe(false);
  }
});
