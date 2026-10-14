/**
 * Provider signup gates Continue on a first name and stashes that name for
 * research onboarding. Role stays optional.
 */

import type { AllauthResult } from "@app/lib/auth/auth-response";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

const getProviderSignup = mock(() =>
  Promise.resolve({
    ok: true as const,
    data: {
      user: {
        email: "user@example.com",
        username: "user1",
        first_name: "",
        last_name: "",
      },
    },
  }),
);

const submitProviderSignup = mock(
  async (): Promise<AllauthResult<unknown>> => ({ ok: true, data: {} }),
);

mock.module("@app/lib/auth/provider-signup-client", () => ({
  getProviderSignup,
  submitProviderSignup,
  isConflict: (result: AllauthResult<unknown>) =>
    !result.ok && result.status === 409,
}));

mock.module("@app/domains/account/assistant-auth-handoff", () => ({
  assistantAuthHandoff: {
    refresh: async () => {},
    read: () => ({
      returningUser: false,
      checkout: { save: () => {}, clear: () => {} },
    }),
  },
}));

const refreshSession = mock(async () => true);

mock.module("@app/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      refreshSession: () => refreshSession,
    },
  },
}));

mock.module("@app/domains/account/components/signup-shell", () => ({
  SignupShell: ({ children }: { children: ReactNode }) => children,
}));

const { ProviderSignupPage } =
  await import("@app/domains/account/pages/provider-signup-page");
const { peekSignupOnboardingFirstName, takeSignupOnboardingFirstName } =
  await import("@app/lib/auth/signup-onboarding-handoff");

function continueButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /continue/i });
}

function renderPage(initialEntry = "/account/provider-signup") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/account/provider-signup"
          element={<ProviderSignupPage />}
        />
        <Route path="/assistant" element={<div>assistant</div>} />
        <Route path="/assistant/checkout" element={<div>checkout</div>} />
        <Route
          path="/assistant/onboarding/privacy"
          element={<div>privacy</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getProviderSignup.mockClear();
  submitProviderSignup.mockClear();
  refreshSession.mockClear();
  takeSignupOnboardingFirstName();
});

afterEach(() => {
  takeSignupOnboardingFirstName();
  cleanup();
});

describe("ProviderSignupPage first name", () => {
  test("Continue is disabled until a first name is entered", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("First name")).toBeTruthy();
    });

    const firstName = screen.getByPlaceholderText(
      "First name",
    ) as HTMLInputElement;
    expect(firstName.disabled).toBe(false);
    expect(firstName.readOnly).toBe(false);
    expect(continueButton().disabled).toBe(true);

    fireEvent.change(firstName, { target: { value: "Alice" } });
    expect(continueButton().disabled).toBe(false);
  });

  test("submits the typed first name into the onboarding handoff", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("First name")).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText("First name"), {
      target: { value: "Alice" },
    });
    fireEvent.click(continueButton());

    await waitFor(() => {
      expect(submitProviderSignup).toHaveBeenCalledTimes(1);
    });
    expect(peekSignupOnboardingFirstName()).toBe("Alice");
    await waitFor(() => expect(screen.getByText("privacy")).toBeTruthy());
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });
});

test("an already-authenticated signup conflict completes as login and retains checkout", async () => {
  submitProviderSignup.mockResolvedValueOnce({
    ok: false,
    status: 409,
    errors: [],
  });
  renderPage(
    "/account/provider-signup?returnTo=%2Fassistant%2Fcheckout%3Fpackage%3Dsuper",
  );
  await waitFor(() =>
    expect(screen.getByPlaceholderText("First name")).toBeTruthy(),
  );
  fireEvent.change(screen.getByPlaceholderText("First name"), {
    target: { value: "Alice" },
  });
  fireEvent.click(continueButton());
  await waitFor(() => expect(screen.getByText("checkout")).toBeTruthy());
  expect(refreshSession).toHaveBeenCalledTimes(1);
});
test("provider signup validation errors do not refresh or navigate", async () => {
  submitProviderSignup.mockResolvedValueOnce({
    ok: false,
    status: 400,
    errors: [{ code: "invalid", message: "Please try again." }],
  });
  renderPage();
  await waitFor(() =>
    expect(screen.getByPlaceholderText("First name")).toBeTruthy(),
  );
  fireEvent.change(screen.getByPlaceholderText("First name"), {
    target: { value: "Alice" },
  });
  fireEvent.click(continueButton());
  await waitFor(() =>
    expect(screen.getByText("Please try again.")).toBeTruthy(),
  );
  expect(refreshSession).not.toHaveBeenCalled();
});
