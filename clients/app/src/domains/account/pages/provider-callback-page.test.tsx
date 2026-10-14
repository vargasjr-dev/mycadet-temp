import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useSearchParams } from "react-router";
import type { AllauthResult } from "@app/lib/auth/auth-response";
let returningUser = false;
const getSession = mock(
  async (): Promise<AllauthResult<{ user: { id: string } }>> => ({
    ok: true,
    data: { user: { id: "user-123" } },
  }),
);
const refreshSession = mock(async () => true);
const refresh = mock(async () => {});
const save = mock((_value: unknown) => {});
mock.module("@app/lib/auth/session-client", () => ({ getSession }));
mock.module("@app/stores/auth-store", () => ({
  useAuthStore: { use: { refreshSession: () => refreshSession } },
}));
mock.module("@app/lib/runtime-mode", () => ({ isLocalClient: () => false }));
mock.module("@app/domains/account/assistant-auth-handoff", () => ({
  assistantAuthHandoff: {
    refresh,
    read: () => ({ returningUser, checkout: { save, clear: () => {} } }),
  },
}));
const { ProviderCallbackPage } = await import("./provider-callback-page");
const checkout = "/assistant/checkout?package=super";
function SignupDestination() {
  const [params] = useSearchParams();
  return <div>provider signup: {params.get("returnTo")}</div>;
}
function renderPage(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/account/provider/callback${search}`]}>
      <Routes>
        <Route
          path="/account/provider/callback"
          element={<ProviderCallbackPage />}
        />
        <Route
          path="/assistant/onboarding/privacy"
          element={<div>privacy</div>}
        />
        <Route path="/assistant" element={<div>assistant</div>} />
        <Route
          path="/account/provider/signup"
          element={<SignupDestination />}
        />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  returningUser = false;
  mock.clearAllMocks();
});
afterEach(cleanup);
test("authenticated signup callback carries checkout into consent after refreshing account and assistant facts", async () => {
  renderPage(`?authIntent=signup&returnTo=${encodeURIComponent(checkout)}`);
  await waitFor(() => expect(screen.getByText("privacy")).toBeTruthy());
  expect(refreshSession).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith({
    kind: "package",
    packageKey: "super",
    resumeAfterOnboarding: true,
  });
});
test("returning signup callback skips first-run consent", async () => {
  returningUser = true;
  renderPage("?authIntent=signup");
  await waitFor(() => expect(screen.getByText("assistant")).toBeTruthy());
});
test("pending provider signup retains returnTo and does not complete authentication", async () => {
  getSession.mockResolvedValueOnce({
    ok: false,
    status: 401,
    errors: [],
    flows: [{ id: "provider_signup", is_pending: true }],
  });
  renderPage(`?returnTo=${encodeURIComponent(checkout)}`);
  await waitFor(() =>
    expect(screen.getByText(`provider signup: ${checkout}`)).toBeTruthy(),
  );
  expect(refreshSession).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});
test("a callback error does not probe or complete authentication", () => {
  renderPage("?error=signup_closed");
  expect(screen.getByText("Signups are currently closed")).toBeTruthy();
  expect(getSession).not.toHaveBeenCalled();
  expect(refreshSession).not.toHaveBeenCalled();
});
