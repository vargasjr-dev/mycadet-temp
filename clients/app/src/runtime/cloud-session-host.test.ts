import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { registerLocalCloudSession } from "@app/runtime/cloud-session-host";

const originalBridge = Object.getOwnPropertyDescriptor(window, "cadet");
const requests = spyOn(globalThis, "fetch");

afterEach(() => {
  requests.mockReset();
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
    expect(await registerLocalCloudSession("session123")).toBe(false);
  }
  expect(requests).not.toHaveBeenCalled();
});

test("local browser hosts receive the same cloud-session POST", async () => {
  Reflect.deleteProperty(window, "cadet");
  requests.mockResolvedValue(new Response('{"ok":true}'));
  expect(await registerLocalCloudSession("session123")).toBe(true);
  expect(requests).toHaveBeenCalledWith("/v1/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"token":"session123"}',
  });
});

test("Electron exposes the host endpoint without injected browser config", async () => {
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: { platform: "electron" },
  });
  requests.mockResolvedValue(new Response('{"ok":true}'));
  expect(await registerLocalCloudSession("session123")).toBe(true);
});

test("unreachable, invalid JSON, and invalid command results fail without throwing", async () => {
  requests.mockRejectedValueOnce(new Error("offline"));
  expect(await registerLocalCloudSession("session123")).toBe(false);
  for (const body of ["not JSON", '{"ok":false}', '{"ok":"true"}', "{}"]) {
    requests.mockResolvedValueOnce(new Response(body));
    expect(await registerLocalCloudSession("session123")).toBe(false);
  }
});
