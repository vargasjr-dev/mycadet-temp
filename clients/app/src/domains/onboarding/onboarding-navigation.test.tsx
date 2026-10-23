/**
 * The funnel's history contract for the two app-owned provisioning steps:
 * every move between setup screens REPLACES the current entry.
 *
 * This is what makes Back inert once setup finishes — a pushed navigation
 * anywhere in the funnel puts an entry back on the stack that a single Back
 * press can then land a finished user on, so the assertions check the options
 * argument, not just the destination.
 *
 * Ported from web's `onboarding-navigation.test.tsx` alongside the screens
 * themselves; the welcome/start screens assert the same contract in their own
 * test files.
 *
 * Self-contained mocks (run this file solo — `mock.module` leaks across a
 * shared `bun test` run).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { NEW_ASSISTANT_PARAM } from "@app/domains/onboarding/onboarding-destination";
import { routes } from "@app/utils/routes";

const navigateMock = mock((_to: string, _opts?: unknown) => {});
let searchParams = new URLSearchParams();

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams, mock(() => {})],
}));

mock.module("@app/lib/runtime-mode", () => ({
  isLocalClient: () => true,
}));

mock.module("@app/stores/auth-store", () => ({
  useAuthStore: (selector: (state: { cloudSession: string }) => unknown) =>
    selector({ cloudSession: "present" }),
}));

// The hosting screen's docs link goes through `ExternalAnchor`, whose click
// handler would otherwise pull the native platform module graph into the test.
mock.module("@app/utils/native-anchor", () => ({
  handleNativeAnchorClick: () => {},
}));

const { HostingScreen } =
  await import("@app/domains/onboarding/pages/hosting-screen");
const { ApiKeyScreen } =
  await import("@app/domains/onboarding/pages/api-key-screen");

/** The options argument of the single `navigate()` this click produced. */
function navigatedWith(): { to: string; opts: unknown } {
  expect(navigateMock).toHaveBeenCalledTimes(1);
  const [to, opts] = navigateMock.mock.calls[0] as [string, unknown];
  return { to, opts };
}

function click(label: string): void {
  fireEvent.click(screen.getByText(label));
}

describe("onboarding funnel history contract", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    searchParams = new URLSearchParams();
    sessionStorage.removeItem("onboarding.providerKey");
  });
  afterEach(cleanup);

  test("HostingScreen replaces going forward", () => {
    render(<HostingScreen />);
    click("Continue");

    const { to, opts } = navigatedWith();
    // Cloud skips the api-key step, so this handoff carries the new-assistant
    // marker itself (see `NEW_ASSISTANT_PARAM`) straight into research.
    expect(to).toBe(`${routes.onboarding.research}?${NEW_ASSISTANT_PARAM}=1`);
    expect(opts).toEqual({ replace: true });
  });

  test("ApiKeyScreen replaces in both directions", () => {
    // A staged key enables the api-key screen's Continue without the test
    // having to drive the provider inputs — and exercises the same sessionStorage
    // contract the hatching screen consumes.
    sessionStorage.setItem(
      "onboarding.providerKey",
      JSON.stringify({ provider: "anthropic", key: "sk-test" }),
    );
    searchParams = new URLSearchParams("hosting=local");
    render(<ApiKeyScreen />);
    click("Back");
    expect(navigatedWith()).toEqual({
      to: routes.account.onboarding.hosting,
      opts: { replace: true },
    });

    navigateMock.mockClear();
    click("Continue");
    const { to, opts } = navigatedWith();
    // Consent settles at the shell's screen before the funnel runs, so the
    // continue hands to the post-consent destination: a local hosting walk
    // runs the foreground local hatch first, so it goes to `hatching`.
    expect(to.startsWith(routes.onboarding.hatching)).toBe(true);
    // The marker is what exempts this walk from the already-onboarded bounce,
    // and the hosting choice still has to reach the hatch. Both ride here.
    const forward = new URLSearchParams(to.slice(to.indexOf("?") + 1));
    expect(forward.get(NEW_ASSISTANT_PARAM)).toBe("1");
    expect(forward.get("hosting")).toBe("local");
    expect(opts).toEqual({ replace: true });
  });
});
