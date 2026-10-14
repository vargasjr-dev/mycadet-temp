import { afterEach, expect, mock, spyOn, test } from "bun:test";
let token: string | undefined = "csrf-value";
const bootstrap = mock(async () => {});
mock.module("@app/lib/auth/csrf", () => ({
  ensureCsrfCookie: bootstrap,
  getCsrfToken: () => token,
}));
const { startProviderRedirect } = await import("./provider-redirect");
const submit = spyOn(HTMLFormElement.prototype, "submit").mockImplementation(
  () => {},
);
afterEach(() => {
  document.querySelectorAll("form").forEach((form) => form.remove());
  token = "csrf-value";
  bootstrap.mockClear();
  submit.mockClear();
});
test("provider form includes CSRF, callback, intent, hint and only allowlisted attribution", async () => {
  await startProviderRedirect(
    "workos",
    "/account/provider/callback?returnTo=%2Fassistant",
    {
      intent: "signup",
      loginHint: "person@example.com",
      attribution: {
        utm_source: "campaign",
        provider: "other",
        callback_url: "https://evil.example",
      },
    },
  );
  const form = document.querySelector("form")!;
  const values = Object.fromEntries(
    Array.from(form.querySelectorAll("input"), (input) => [
      input.name,
      input.value,
    ]),
  );
  expect(values).toEqual({
    provider: "workos",
    callback_url: new URL(
      "/account/provider/callback?returnTo=%2Fassistant",
      window.location.origin,
    ).href,
    process: "login",
    intent: "signup",
    login_hint: "person@example.com",
    utm_source: "campaign",
    csrfmiddlewaretoken: "csrf-value",
  });
  expect(form.method.toLowerCase()).toBe("post");
  expect(form.action).toBe(
    `${window.location.origin}/_allauth/browser/v1/auth/provider/redirect`,
  );
  expect(bootstrap).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(1);
});
test("missing CSRF prevents form submission", async () => {
  token = undefined;
  await expect(
    startProviderRedirect("workos", "/account/provider/callback"),
  ).rejects.toThrow("CSRF token is missing");
  expect(submit).not.toHaveBeenCalled();
  expect(document.querySelector("form")).toBeNull();
});
