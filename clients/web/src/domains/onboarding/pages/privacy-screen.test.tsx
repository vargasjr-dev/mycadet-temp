import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SKIP_RESEARCH_PARAM } from "@/domains/onboarding/onboarding-destination";
import { ONBOARDED_HATCH_AGE_MS } from "@/domains/onboarding/onboarded-assistant";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  clearSelectedAssistantId,
  writeSelectedAssistantId,
} from "@/assistant/selected-assistant-storage";
import { routes } from "@/utils/routes";

// react-router: capture navigate() targets and drive the ?preview flag.
const navigateMock = mock((..._args: unknown[]) => {});
let searchParamsValue = new URLSearchParams();
mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParamsValue, mock(() => {})],
}));

// Consent setters — spied so we can assert they are NOT persisted in preview.
const setTosAccepted = mock((_next: boolean) => {});
const setPrivacyConsent = mock((_next: boolean) => {});
mock.module("@/domains/onboarding/prefs", () => ({
  useTosAccepted: () => [true, setTosAccepted],
  usePrivacyConsent: () => [true, setPrivacyConsent],
}));

const saveConsentMock = mock((_args: unknown) => {});
mock.module("@/lib/consent/consent-persistence", () => ({
  saveConsent: saveConsentMock,
}));

mock.module("@/runtime/is-electron", () => ({ isElectron: () => true }));
// Mutable platform/flag state so individual tests can flip them.
let nativePlatform = false;
let localMode = false;
mock.module("@/lib/local-mode", () => ({ isLocalClient: () => localMode }));
mock.module("@/runtime/native-auth", () => ({
  useIsNativePlatform: () => nativePlatform,
}));
// The consent link goes through `ExternalAnchor`; stub its click handler so it
// does not reach for exports the partial native-auth mock above leaves out.
mock.module("@/utils/native-anchor", () => ({
  handleNativeAnchorClick: () => {},
}));
mock.module("@/stores/auth-store", () => ({
  useAuthStore: { use: { user: () => ({ id: "user-1" }) } },
  useHasCloudSession: () => false,
}));
mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: { stringFlags: () => ({}) },
  },
}));

// Light passthroughs for layout/design-library so the screen renders in happy-dom.
mock.module("@/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: React.ReactNode }) => children,
}));
mock.module("@/domains/onboarding/components/step-indicator-dots", () => ({
  StepIndicatorDots: () => null,
}));
mock.module("lucide-react", () => ({
  EyeOff: () => null,
  ExternalLink: () => null,
}));
mock.module("@mycadet/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
mock.module("@mycadet/design-library/components/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
mock.module("@mycadet/design-library/components/checkbox", () => ({
  Checkbox: () => null,
}));
mock.module("@mycadet/design-library/components/toggle", () => ({
  Toggle: () => null,
}));

const { PrivacyScreen } =
  await import("@/domains/onboarding/pages/privacy-screen");

function clickStart(): void {
  fireEvent.click(screen.getByText("Start Onboarding"));
}

function clickSkipToChat(): void {
  fireEvent.click(screen.getByText("Skip to the Assistant"));
}

/** The query of the single URL `navigate()` was called with. */
describe("PrivacyScreen — Start navigation", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    saveConsentMock.mockClear();
    nativePlatform = false;
    localMode = false;
    useResolvedAssistantsStore.setState({ assistants: [] });
    clearSelectedAssistantId();
  });
  afterEach(() => {
    cleanup();
    nativePlatform = false;
    localMode = false;
    useResolvedAssistantsStore.setState({ assistants: [] });
    clearSelectedAssistantId();
  });

  test("preview mode no-ops on Start without persisting consent", () => {
    searchParamsValue = new URLSearchParams("preview=true");
    render(<PrivacyScreen />);

    clickStart();

    // Developer "Replay Onboarding": preview mode allows only non-side-effecting
    // routes, so Start is a no-op — it neither navigates nor persists consent.
    expect(navigateMock).not.toHaveBeenCalled();
    expect(saveConsentMock).not.toHaveBeenCalled();
  });

  test("web persists consent and advances to the research flow, preserving hosting", () => {
    nativePlatform = false;
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickStart();

    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.research)).toBe(true);
    expect(target).toContain("hosting=managed");
  });

  test("carries the marketing plugin attribution forward to the research flow", () => {
    nativePlatform = false;
    searchParamsValue = new URLSearchParams(
      "hosting=managed&plugin=coffee-aficionado",
    );
    render(<PrivacyScreen />);

    clickStart();

    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.research)).toBe(true);
    // The runner reads `plugin` off the (stable) research URL to pre-install it.
    expect(target).toContain("plugin=coffee-aficionado");
    expect(target).toContain("hosting=managed");
  });

  test("local hosting routes to hatching first (foreground local hatch), preserving hosting", () => {
    localMode = true;
    nativePlatform = false;
    searchParamsValue = new URLSearchParams("hosting=local");
    render(<PrivacyScreen />);

    clickStart();

    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.hatching)).toBe(true);
    expect(target).toContain("hosting=local");
  });

  test("native follows the same research onboarding as web", () => {
    nativePlatform = true;
    searchParamsValue = new URLSearchParams();
    render(<PrivacyScreen />);

    clickStart();

    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.research, {
      replace: true,
    });
  });

  test("skips research when the selected assistant is over a week old", () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "asst-1",
          hatchedAt: new Date(
            Date.now() - ONBOARDED_HATCH_AGE_MS,
          ).toISOString(),
          isLocal: false,
          isCloudHosted: true,
          isPaired: false,
        },
      ],
    });
    writeSelectedAssistantId("asst-1");
    searchParamsValue = new URLSearchParams();
    render(<PrivacyScreen />);

    clickStart();

    expect(navigateMock).toHaveBeenCalledWith(routes.assistant, {
      replace: true,
    });
  });

  // The chooser loop: an established sibling must not answer for the assistant
  // this walk is creating.
  test("still hatches when a week-old sibling is not the selected assistant", () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "asst-old",
          hatchedAt: new Date(
            Date.now() - ONBOARDED_HATCH_AGE_MS,
          ).toISOString(),
          isLocal: false,
          isCloudHosted: true,
          isPaired: false,
        },
        {
          id: "asst-new",
          hatchedAt: new Date().toISOString(),
          isLocal: false,
          isCloudHosted: true,
          isPaired: false,
        },
      ],
    });
    writeSelectedAssistantId("asst-new");
    searchParamsValue = new URLSearchParams();
    render(<PrivacyScreen />);

    clickStart();

    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.research, {
      replace: true,
    });
  });

  // The funnel is one history entry, so Back can never re-enter it after setup
  // finishes — a pushed step here would put consent back on the stack.
  test("advances by replacing the current history entry, never pushing", () => {
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickStart();

    expect(navigateMock.mock.calls[0]?.[1]).toEqual({ replace: true });
  });
});

describe("PrivacyScreen — Skip to chat", () => {
  const env = import.meta.env as Record<string, string | undefined>;
  let previousEnv: string | undefined;

  beforeEach(() => {
    previousEnv = env.VITE_ENVIRONMENT;
    env.VITE_ENVIRONMENT = "staging";
    navigateMock.mockClear();
    saveConsentMock.mockClear();
    nativePlatform = false;
    localMode = false;
  });
  afterEach(() => {
    env.VITE_ENVIRONMENT = previousEnv;
    cleanup();
    nativePlatform = false;
    localMode = false;
  });

  test("saves consent and hatches, skipping the research funnel", () => {
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickSkipToChat();

    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.hatching)).toBe(true);
    expect(target).toContain("hosting=managed");
    expect(target).toContain(`${SKIP_RESEARCH_PARAM}=1`);
    expect(navigateMock.mock.calls[0]?.[1]).toEqual({ replace: true });
  });

  test("preview mode no-ops on Skip to chat without persisting consent", () => {
    searchParamsValue = new URLSearchParams("preview=true");
    render(<PrivacyScreen />);

    clickSkipToChat();

    expect(navigateMock).not.toHaveBeenCalled();
    expect(saveConsentMock).not.toHaveBeenCalled();
  });
});

describe("PrivacyScreen — Back navigation", () => {
  const assignMock = mock((_url: string) => {});

  beforeEach(() => {
    navigateMock.mockClear();
    assignMock.mockClear();
    nativePlatform = false;
    localMode = false;
    searchParamsValue = new URLSearchParams();
    // Guard against regressions: Back must stay inside the SPA and never reach
    // for a full-document navigation to the marketing host.
    Object.defineProperty(window, "location", {
      value: { assign: assignMock },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
    nativePlatform = false;
    localMode = false;
  });

  test("local mode: Back returns to the hosting screen deterministically", () => {
    localMode = true;
    render(<PrivacyScreen />);

    fireEvent.click(screen.getByText("Back"));

    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.hosting, {
      replace: true,
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  test("platform mode: Back lands on the in-SPA onboarding start screen", () => {
    localMode = false;
    render(<PrivacyScreen />);

    fireEvent.click(screen.getByText("Back"));

    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.start, {
      replace: true,
    });
    // Must not leave the SPA for the marketing host — that would switch a
    // Capacitor staging/dev shell onto production.
    expect(assignMock).not.toHaveBeenCalled();
  });

  test("native platform shell: Back stays in-SPA (no marketing-host escape)", () => {
    // The environment-preservation case Codex flagged: on Capacitor
    // staging/dev, isLocalClient() is false, so platform-mode Back applies. It
    // must remain an in-SPA navigation, never a full-document nav to `/`.
    localMode = false;
    nativePlatform = true;
    render(<PrivacyScreen />);

    fireEvent.click(screen.getByText("Back"));

    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.start, {
      replace: true,
    });
    expect(assignMock).not.toHaveBeenCalled();
  });
});
