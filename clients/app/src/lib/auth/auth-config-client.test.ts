import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { getAuthConfig } from "@app/lib/auth/auth-config-client";
import { changeLocale } from "@app/i18n";

const originalConfig = Object.getOwnPropertyDescriptor(
  window,
  "__CADET_CONFIG__",
);
const originalBridge = Object.getOwnPropertyDescriptor(window, "cadet");
const fetchSpy = spyOn(globalThis, "fetch");
afterAll(() => fetchSpy.mockRestore());
afterEach(async () => {
  fetchSpy.mockReset();
  for (const [key, descriptor] of [
    ["cadet", originalBridge],
    ["__CADET_CONFIG__", originalConfig],
  ] as const) {
    if (descriptor) Object.defineProperty(window, key, descriptor);
    else Reflect.deleteProperty(window, key);
  }
  await changeLocale("en");
  localStorage.removeItem("device:locale");
});

test("browser signup configuration uses same-origin cookies and app language", async () => {
  Reflect.deleteProperty(window, "cadet");
  await changeLocale("es");
  fetchSpy.mockResolvedValue(
    new Response('{"data":{"account":{"is_open_for_signup":false}}}'),
  );
  expect(await getAuthConfig()).toEqual({
    ok: true,
    data: { account: { is_open_for_signup: false } },
  });
  const [url, options] = fetchSpy.mock.calls[0]!;
  expect(url).toBe("/_allauth/browser/v1/config");
  expect(options?.credentials).toBe("same-origin");
  const headers = new Headers(options?.headers);
  expect(headers.get("Accept-Language")).toBe("es");
  expect(headers.has("X-Session-Token")).toBe(false);
});

test("Electron configuration uses the host cloud origin and current session token", async () => {
  let token = "session-one";
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: { platform: "electron", auth: { getSessionToken: () => token } },
  });
  Object.defineProperty(window, "__CADET_CONFIG__", {
    configurable: true,
    value: { cloudUrl: "https://cloud.example.com" },
  });
  fetchSpy.mockImplementation(
    Object.assign(
      async () =>
        new Response('{"data":{"account":{"is_open_for_signup":true}}}'),
      { preconnect: () => {} },
    ),
  );
  expect((await getAuthConfig()).ok).toBe(true);
  expect(fetchSpy.mock.calls[0]?.[0]).toBe(
    "https://cloud.example.com/_allauth/app/v1/config",
  );
  expect(
    new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("X-Session-Token"),
  ).toBe("session-one");
  token = "session-two";
  await getAuthConfig();
  expect(
    new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get("X-Session-Token"),
  ).toBe("session-two");
});

test("HTTP failures, invalid payloads, and offline responses fail safely", async () => {
  Reflect.deleteProperty(window, "cadet");
  for (const response of [
    new Response("{}"),
    new Response('{"data":{"account":{"is_open_for_signup":"false"}}}'),
    new Response('{"data":{"account":{"is_open_for_signup":false}}}', {
      status: 500,
    }),
    new Response("not JSON"),
  ]) {
    fetchSpy.mockResolvedValueOnce(response);
    expect((await getAuthConfig()).ok).toBe(false);
  }
  fetchSpy.mockRejectedValueOnce(new Error("offline"));
  expect((await getAuthConfig()).ok).toBe(false);
});
