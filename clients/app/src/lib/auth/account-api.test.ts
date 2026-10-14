import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { getSession, logoutAccountSession } from "@app/lib/auth/session-client";
import {
  getProviderSignup,
  isConflict,
  submitProviderSignup,
} from "@app/lib/auth/provider-signup-client";

const originalBridge = Object.getOwnPropertyDescriptor(window, "cadet");
const originalConfig = Object.getOwnPropertyDescriptor(
  window,
  "__CADET_CONFIG__",
);
const fetchSpy = spyOn(globalThis, "fetch");
afterAll(() => fetchSpy.mockRestore());
afterEach(() => {
  fetchSpy.mockReset();
  document.cookie = "csrftoken=; max-age=0; path=/";
  for (const [key, descriptor] of [
    ["cadet", originalBridge],
    ["__CADET_CONFIG__", originalConfig],
  ] as const) {
    if (descriptor) Object.defineProperty(window, key, descriptor);
    else Reflect.deleteProperty(window, key);
  }
});

test("session reads retain pending provider-signup flows", async () => {
  Reflect.deleteProperty(window, "cadet");
  fetchSpy.mockResolvedValue(
    new Response(
      '{"data":{"flows":[{"id":"provider_signup","is_pending":true}]}}',
      { status: 401 },
    ),
  );
  expect(await getSession()).toEqual({
    ok: false,
    status: 401,
    errors: [],
    flows: [{ id: "provider_signup", is_pending: true }],
  });
  expect(fetchSpy.mock.calls[0]?.[0]).toBe("/_allauth/browser/v1/auth/session");
});

test("browser signup reads user context and sends its CSRF token on submission", async () => {
  Reflect.deleteProperty(window, "cadet");
  document.cookie = "csrftoken=csrf123; path=/";
  fetchSpy.mockResolvedValueOnce(
    new Response(
      '{"data":{"user":{"email":"a@example.com","first_name":"Ada"}}}',
    ),
  );
  const context = await getProviderSignup();
  expect(context.ok && context.data.user.first_name).toBe("Ada");
  fetchSpy.mockResolvedValueOnce(
    new Response('{"data":{"user":{"username":"ada"}}}'),
  );
  expect(
    (await submitProviderSignup({ email: "a@example.com", username: "ada" }))
      .ok,
  ).toBe(true);
  const [, request] = fetchSpy.mock.calls[1]!;
  expect(request?.method).toBe("POST");
  expect(new Headers(request?.headers).get("X-CSRFToken")).toBe("csrf123");
  expect(request?.body).toBe('{"email":"a@example.com","username":"ada"}');
});

test("browser signup bootstraps a missing CSRF cookie before mutation", async () => {
  Reflect.deleteProperty(window, "cadet");
  document.cookie = "csrftoken=; max-age=0; path=/";
  fetchSpy.mockImplementationOnce(
    Object.assign(
      async () => {
        document.cookie = "csrftoken=bootstrapped; path=/";
        return new Response("{}");
      },
      { preconnect: () => {} },
    ),
  );
  fetchSpy.mockResolvedValueOnce(new Response('{"data":{"user":{}}}'));
  await submitProviderSignup({ email: "a@example.com", username: "ada" });
  expect(fetchSpy.mock.calls[0]?.[0]).toBe("/_allauth/browser/v1/auth/session");
  expect(
    new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get("X-CSRFToken"),
  ).toBe("bootstrapped");
});

test("Electron mutations carry native token and renderer origin without CSRF", async () => {
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: {
      platform: "electron",
      auth: { getSessionToken: () => "session123" },
    },
  });
  Object.defineProperty(window, "__CADET_CONFIG__", {
    configurable: true,
    value: { cloudUrl: "https://cloud.example.com" },
  });
  fetchSpy.mockResolvedValueOnce(new Response('{"data":{"user":{}}}'));
  await submitProviderSignup({ email: "a@example.com", username: "ada" });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy.mock.calls[0]?.[0]).toBe(
    "https://cloud.example.com/_allauth/app/v1/auth/provider/signup",
  );
  const headers = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
  expect(headers.get("X-Session-Token")).toBe("session123");
  expect(headers.get("X-Cadet-Electron-Renderer-Origin")).toBe(
    `${window.location.protocol}//${window.location.host}`,
  );
  expect(headers.has("X-CSRFToken")).toBe(false);
});

test("conflicts and validation errors preserve their status and message", async () => {
  Reflect.deleteProperty(window, "cadet");
  fetchSpy.mockResolvedValueOnce(
    new Response(
      '{"errors":[{"code":"account_exists","message":"Already registered"}]}',
      { status: 409 },
    ),
  );
  const result = await getProviderSignup();
  expect(isConflict(result)).toBe(true);
  expect(!result.ok && result.errors[0]?.message).toBe("Already registered");
  fetchSpy.mockResolvedValueOnce(new Response('{"data":{"user":{"id":123}}}'));
  expect((await getSession()).ok).toBe(false);
});

test("successful anonymous session responses expose no account user", async () => {
  for (const data of [{ user: null }, {}]) {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data })));
    const result = await getSession();
    expect(result.ok).toBe(true);
    expect(result.ok && result.data.user).toBeFalsy();
  }
});

test("cloud logout sends a CSRF-protected DELETE and accepts an already-ended session", async () => {
  document.cookie = "csrftoken=logout-csrf; path=/";
  document.cookie = "__Secure-csrftoken=logout-csrf; path=/";
  fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 401 }));
  await logoutAccountSession();
  const [url, options] = fetchSpy.mock.calls[0]!;
  expect(String(url)).toContain("/auth/session");
  expect(options?.method).toBe("DELETE");
  expect(new Headers(options?.headers).get("X-CSRFToken")).toBe("logout-csrf");
});
test("cloud logout rejects a failed revocation instead of reporting success", async () => {
  document.cookie = "csrftoken=logout-csrf; path=/";
  document.cookie = "__Secure-csrftoken=logout-csrf; path=/";
  fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 403 }));
  await expect(logoutAccountSession()).rejects.toThrow("Unable to sign out");
});
