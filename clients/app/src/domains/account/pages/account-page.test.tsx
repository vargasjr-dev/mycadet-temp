import { afterEach, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
const logout = mock(async () => {
  throw new Error("revocation failed");
});
const navigate = mock((_target: string) => {});
const report = mock((_error: unknown, _options: unknown) => {});
mock.module("@app/stores/auth-store", () => ({
  useIsAuthenticated: () => true,
  useIsSessionInitializing: () => false,
  useAuthStore: {
    use: {
      user: () => ({ kind: "cloud", id: "cloud", firstName: "Person" }),
      logout: () => logout,
    },
  },
}));
mock.module("@app/lib/auth/auth-flow", () => ({
  startAuthFlow: async () => {},
}));
mock.module("@app/lib/auth/hard-navigate", () => ({ hardNavigate: navigate }));
mock.module("@mycadet/design-library/utils/capture-error", () => ({
  captureError: report,
}));
const { AccountPage } = await import("./account-page");
afterEach(cleanup);
test("failed cloud revocation is reported and still destroys the account page's execution context", async () => {
  render(
    <MemoryRouter>
      <AccountPage />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/account/login"));
  expect(logout).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith(expect.any(Error), {
    context: "account_logout",
  });
});
