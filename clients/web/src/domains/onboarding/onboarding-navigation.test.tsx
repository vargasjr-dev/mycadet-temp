/**
 * The funnel's history contract: every move between setup screens REPLACES the
 * current entry.
 *
 * This is what makes Back inert once setup finishes. The handoff to chat has
 * always replaced, but that drops one entry — so before this contract, each
 * screen the funnel pushed on the way in survived, and a single Back press
 * landed a finished user back inside setup (`onboarding/start` on platform,
 * `onboarding/hatching` in local mode). A pushed navigation anywhere in the
 * funnel puts that entry back on the stack, which is exactly the regression
 * these assertions catch — so they check the options argument, not just the
 * destination.
 *
 * Covers the screens with no test file of their own; `StartScreen` asserts the
 * same contract in `pages/start-screen.test.tsx`, and `PrivacyScreen` /
 * `HatchingScreen` in theirs.
 *
 * Self-contained mocks (run this file solo — `mock.module` leaks across a shared
 * `bun test` run).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";

import { NEW_ASSISTANT_PARAM } from "@/domains/onboarding/onboarding-destination";
import { routes } from "@/utils/routes";

const navigateMock = mock((_to: string, _opts?: unknown) => {});
const hardNavigateMock = mock((_to: string) => {});
mock.module("@/lib/auth/hard-navigate", () => ({
  hardNavigate: hardNavigateMock,
}));
let searchParamsValue = new URLSearchParams();

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParamsValue, mock(() => {})],
  // The welcome screen's shared chrome renders a `Link` for the secondary
  // action on the surfaces that navigate rather than handle it in place.
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

let localAssistants = false;
mock.module("@/lib/local-mode", () => ({
  hasAssistants: () => localAssistants,
  isLocalClient: () => true,
}));

mock.module("@/hooks/use-onboarding-login", () => ({
  useOnboardingLogin: () => ({
    loading: false,
    error: null,
    login: mock(() => {}),
    cancel: mock(() => {}),
  }),
}));

mock.module("@/runtime/is-electron", () => ({ isElectron: () => false }));

// The screens' external links go through `ExternalAnchor`, whose click handler
// would otherwise pull the native-auth module graph past the partial mocks
// below.
mock.module("@/utils/native-anchor", () => ({
  handleNativeAnchorClick: () => {},
}));

mock.module("@/lib/self-hosted/connection", () => ({
  setSelfHostedConnection: mock(() => {}),
}));
mock.module("@/domains/onboarding/provider-key", () => ({
  setPendingProviderKey: mock(() => {}),
  // A staged key so the api-key screen's Continue is enabled without the test
  // having to drive the (mocked-out) provider inputs.
  peekPendingProviderKey: () => ({ provider: "anthropic", key: "sk-test" }),
}));

mock.module("@/stores/auth-store", () => ({
  useHasCloudSession: () => true,
}));
mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: { multiCloudAssistant: () => true },
  },
}));
mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: { assistants: () => [] },
    getState: () => ({ assistants: [] }),
  },
}));

mock.module("@/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: ReactNode }) => children,
}));

mock.module("@mycadet/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
mock.module("@mycadet/design-library/components/select", () => ({
  Select: () => null,
}));
mock.module("@mycadet/design-library/components/input", () => ({
  Input: () => null,
}));

const { HostingScreen } =
  await import("@/domains/onboarding/pages/hosting-screen");
const { ApiKeyScreen } =
  await import("@/domains/onboarding/pages/api-key-screen");

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
    searchParamsValue = new URLSearchParams();
    localAssistants = false;
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

  // The in-screen Back affordances have to replace too: a pushed back-step is
  // an entry the user can then Back INTO after finishing.
  test("HostingScreen bounces back to the app-owned welcome", () => {
    render(<HostingScreen />);
    click("Back");

    // The predecessor moved to the app bundle
    // (`/account/onboarding/welcome`) — the Back handoff is a cross-bundle
    // full-page navigation, not a client-side replace.
    expect(hardNavigateMock).toHaveBeenCalledWith(routes.welcome);
  });

  test("ApiKeyScreen replaces in both directions", () => {
    searchParamsValue = new URLSearchParams("hosting=local");
    render(<ApiKeyScreen />);

    click("Back");
    expect(navigatedWith()).toEqual({
      to: routes.onboarding.hosting,
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
