/**
 * The shared auth-entry contract run against the login page, plus the things
 * only this page decides: the native/web split of the waiting shell and of the
 * sign-in screen itself.
 */

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import {
  CHECKOUT,
  authEntry,
  describeAuthEntryContract,
  entryUrl,
  mockAuthStore,
  mockHardNavigate,
  mockNativeAuth,
  renderAuthEntry,
  setupAuthEntry,
} from "@app/domains/account/pages/auth-entry-contract-test-helpers";

mock.module("@app/stores/auth-store", mockAuthStore);
mock.module("@app/runtime/native-login", mockNativeAuth);
mock.module("@app/runtime/native-platform", mockNativeAuth);
mock.module("@app/lib/auth/auth-flow", mockNativeAuth);
mock.module("@app/lib/auth/hard-navigate", mockHardNavigate);

const { LoginPage } = await import("@app/domains/account/pages/login-page");

const ROUTE = "/account/login";

describeAuthEntryContract("LoginPage", {
  Page: LoginPage,
  route: ROUTE,
  authScreenText: "Welcome to Cadet",
});

describe("LoginPage sign-up cross-link", () => {
  setupAuthEntry();

  const signUpLink = () => screen.getByText("Sign up").getAttribute("href");

  // Allowlist filtering and organic/bare behavior are covered by the
  // withPreservedAttribution unit tests; this exercises the page wiring.
  test("carries attribution from the current URL alongside returnTo", () => {
    renderAuthEntry(
      LoginPage,
      ROUTE,
      `${entryUrl(ROUTE, CHECKOUT)}&utm_source=ig&fbclid=abc123`,
    );

    expect(signUpLink()).toBe(
      `/account/signup?returnTo=${encodeURIComponent(CHECKOUT)}&utm_source=ig&fbclid=abc123`,
    );
  });
});

describe("LoginPage native split", () => {
  setupAuthEntry();

  const renderEntry = () =>
    renderAuthEntry(LoginPage, ROUTE, entryUrl(ROUTE, CHECKOUT));

  test("the browser gets the account welcome screen", () => {
    renderEntry();

    expect(screen.getByText("Welcome to Cadet")).toBeTruthy();
    const comingSoon = screen
      .getByText("Coming Soon!")
      .closest("button") as HTMLButtonElement;
    expect(comingSoon.disabled).toBe(true);
    expect(screen.getByText("Sign up")).toBeTruthy();
    // The account is not optional here — that route past it belongs to the
    // local client's copy of this screen.
    expect(screen.queryByText("Continue without account")).toBeNull();
  });

  test("the wait holds the account shell in the browser", () => {
    authEntry.initializing = true;
    renderEntry();

    expect(screen.getByLabelText("Loading")).toBeTruthy();
    expect(screen.queryByText("Welcome to Cadet")).toBeNull();
  });

  test("the wait holds the account shell on native", () => {
    authEntry.initializing = true;
    authEntry.native = true;
    renderEntry();

    expect(screen.getByLabelText("Loading")).toBeTruthy();
    expect(screen.queryByText("Welcome to Cadet")).toBeNull();
  });

  /**
   * The phone builds are a shell around this same app, so their front door is
   * the browser's front door: the heading, the body line, and the account layout
   * behind them. Only the handoff is native, and only the secondary action
   * differs: signup is a web route the native shell does not offer.
   */
  test("the native sign-in screen is the welcome screen, minus the signup link", () => {
    authEntry.native = true;
    renderEntry();

    expect(screen.getByText("Welcome to Cadet")).toBeTruthy();
    // AuthKit hosts the provider selection, so the native screen offers this
    // one button and nothing beside it. See `docs/CAPACITOR.md`.
    expect(screen.getByText("Sign in")).toBeTruthy();
    expect(screen.queryByText("Sign up")).toBeNull();
    expect(screen.queryByText("Continue without account")).toBeNull();
  });
});

/**
 * The login hand-off is not wired up yet: the primary button reads Coming
 * Soon! and stays inert — no flow can start from it, on any press.
 */
describe("LoginPage web handoff", () => {
  setupAuthEntry();

  test("the login button is Coming Soon! and starts no flow", () => {
    renderAuthEntry(LoginPage, ROUTE, entryUrl(ROUTE, CHECKOUT));

    const button = screen
      .getByText("Coming Soon!")
      .closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);

    expect(authEntry.authFlowCalls).toHaveLength(0);
  });
});

/**
 * What the user is left looking at when the cloud refuses the sign-in — the
 * failure they report as "I tried to log in and it errored right away". The
 * refusal happens in the session exchange that runs after the auth sheet
 * closes, and the native shell names its cause in `data.authError`.
 */
describe("LoginPage native sign-in failures", () => {
  setupAuthEntry();

  const nativeRejection = (code: string, data?: Record<string, unknown>) =>
    Object.assign(new Error("rejected"), { code, ...(data ? { data } : {}) });

  const signIn = () => {
    authEntry.native = true;
    renderAuthEntry(LoginPage, ROUTE, entryUrl(ROUTE, CHECKOUT));
    fireEvent.click(screen.getByText("Sign in"));
  };

  test("a closed signup is explained, not reported as a generic glitch", async () => {
    authEntry.nativeLoginError = nativeRejection("AUTH_ERROR", {
      authError: "signup_closed",
    });
    signIn();

    await waitFor(() => {
      expect(screen.getByText(/not accepting new signups/)).toBeTruthy();
    });
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
  });

  test("an unlinked provider account says an account is needed first", async () => {
    authEntry.nativeLoginError = nativeRejection("AUTH_ERROR", {
      authError: "provider_signup",
    });
    signIn();

    await waitFor(() => {
      expect(screen.getByText(/No Cadet account is linked/)).toBeTruthy();
    });
  });

  test("an unclassified failure still falls back to the generic message", async () => {
    authEntry.nativeLoginError = new Error("Failed to fetch");
    signIn();

    await waitFor(() => {
      expect(screen.getByText(/Something went wrong/)).toBeTruthy();
    });
  });

  test("a dismissed auth sheet shows no error at all", async () => {
    authEntry.nativeLoginError = nativeRejection("USER_CANCELLED");
    signIn();

    // The CTA re-enables, so the dismissal has been processed rather than
    // simply not having landed yet.
    await waitFor(() => {
      expect(screen.getByText("Sign in").closest("button")?.disabled).toBe(
        false,
      );
    });
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
  });
});
