/**
 * Route-level regression tests for the research-onboarding resume guard and the
 * paid-checkout return.
 *
 * The established-assistant guard used to run only on form submit; a restored
 * post-form snapshot (persisted before the verdict settled, or after a transient
 * fail-open) re-fired the research turn via the mid-flow resume effect with NO
 * established check, silently re-onboarding an assistant that already had a life.
 * These tests pin the fix: a restored post-form journey consults the guard first
 * and diverts to the keep/redo decision screen when established, while a fresh
 * assistant resumes exactly as before. A form-submit case guards the shared-gate
 * refactor.
 *
 * They also cover the two follow-ups from Codex on #38405: the guard runs for a
 * snapshot hydrated straight to "done" (not just an idle one), and parking on
 * the guard from a resume never persists a resumable `step: "existing"` snapshot
 * — so a refresh re-lands on the keep/redo choice instead of auto-resuming past
 * it.
 *
 * The paid-return block covers the `post_checkout=1` marker reaching the
 * background hatch, and the failure banner: its at-capacity download off-ramp,
 * the funnel staying usable underneath it, and everything that must stay held
 * while the hatch is dead (the auto-advancing loading step, the terminal
 * handoffs). The retry block covers what "Try again" has to un-poison: route
 * state that resolved against the dead hatch and would otherwise survive it.
 *
 * Self-contained mocks (run this file solo — `mock.module` leaks across a shared
 * `bun test` run).
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { readOnboardedAt } from "@/domains/onboarding/onboarded-assistant-record";
import {
  readResearchSnapshot,
  writeResearchSnapshot,
  type ResearchOnboardingSnapshot,
} from "@/domains/onboarding/research-onboarding-persistence";

const ASSISTANT_ID = "asst-1";

const navigateMock = mock((_to: string, _opts?: unknown) => {});
const searchParams = new URLSearchParams();

let researchStatus = "idle";
// Mirrors the real runner, which flips to "running" synchronously inside
// `start` — that is what keeps the mid-flow resume effect from firing a second
// turn behind a form submit.
const startResearchMock = mock((_opts: unknown) => {
  researchStatus = "running";
});
const hydrateResearchMock = mock(
  (results: { status?: string }, _await?: unknown) => {
    if (results.status) {
      researchStatus = results.status;
    }
  },
);
const resetResearchMock = mock(() => {});
const reinstallPluginsMock = mock((_names: string[], _await: unknown) => {});
let installedPlugins: string[] = [];
const researchRunner = {
  get status() {
    return researchStatus;
  },
  claims: [] as unknown[],
  droppedClaims: [] as string[],
  suggestions: [] as unknown[],
  get installedPlugins() {
    return installedPlugins;
  },
  start: startResearchMock,
  hydrate: hydrateResearchMock,
  reset: resetResearchMock,
  reinstallPlugins: reinstallPluginsMock,
  awaitPluginInstalls: async () => {},
};

let establishedResult: { established: boolean; assistantName: string | null } =
  {
    established: false,
    assistantName: null,
  };
// When armed, the established-assistant check blocks on this gate so a test can
// hold the verdict — exercising the window where the resumed terminal step is
// already on screen but the guard hasn't settled — then release it on demand.
let establishedCheckGate: Promise<void> | null = null;
let releaseEstablishedCheck: () => void = () => {};
function armDelayedEstablishedCheck() {
  establishedCheckGate = new Promise<void>((resolve) => {
    releaseEstablishedCheck = resolve;
  });
}
const checkEstablishedAssistantMock = mock(async (_id: string) => {
  if (establishedCheckGate) {
    await establishedCheckGate;
  }
  return establishedResult;
});

// The hatch's readiness promise is swapped per test (a dead first attempt
// rejects; the retry hands back a healthy one), and `onRetryHatch` is where a
// test stages that recovery — it runs inside the overlay's click, exactly where
// the real `retry()` would clear the hook's terminal state.
let awaitHatchReady: () => Promise<string> = async () => "asst-1";
let onRetryHatch: () => void = () => {};
const retryHatchMock = mock(() => {
  onRetryHatch();
});
const backgroundHatch = {
  start: () => {},
  retry: retryHatchMock,
  ready: true,
  assistantId: "asst-1" as string | null,
  error: null as string | null,
  awaitReady: () => awaitHatchReady(),
};
const useBackgroundHatchMock = mock(
  (_options: { postCheckoutReturn?: boolean }) => backgroundHatch,
);

const noop = () => {};

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams],
}));

mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: {
    checkAssistant: async () => {},
    markExpectingFirstMessage: () => {},
  },
}));

const localModeModule = await import("@/lib/local-mode");
mock.module("@/lib/local-mode", () => ({
  ...localModeModule,
  isLocalClient: () => false,
  isGatewaySessionLive: () => false,
}));

// The real module builds its destinations from `routes` at import time, and the
// `@/utils/routes` stub below carries only the assistant path.
mock.module("@/lib/navigation/navigation-resolver", () => ({
  POST_CHECKOUT_HATCH_PARAM: "post_checkout",
}));

let hasCloudSession = true;
let cloudSessionSettled = true;

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      user: () => ({
        id: ASSISTANT_ID,
        firstName: "Alice",
        lastName: "Example",
      }),
    },
  },
  useHasCloudSession: () => hasCloudSession,
  useIsCloudSessionSettled: () => cloudSessionSettled,
}));

mock.module("@/utils/routes", () => ({
  routes: { assistant: "/assistant" },
}));

mock.module("@/utils/use-bundled-avatar-components", () => ({
  preloadBundledAvatarComponents: () => {},
}));

mock.module("@/domains/onboarding/prechat-names", () => ({
  DEFAULT_GROUP_ID: "default",
  RESEARCH_NAMING_VARIANTS: {
    randomized: "random_initial",
    custom: "custom_name",
  },
}));

mock.module("@/domains/onboarding/prechat", () => ({
  setPendingAssistantName: () => {},
  setPendingPreChatContext: () => {},
}));

mock.module("@/domains/onboarding/research-prompt", () => ({
  buildResearchPrompt: () => "research prompt",
}));

let adoptExistingAssistant = false;

mock.module("@/domains/onboarding/adopt-existing-assistant", () => ({
  shouldAdoptExistingAssistant: () => adoptExistingAssistant,
}));

mock.module("@/domains/onboarding/use-background-hatch", () => ({
  useBackgroundHatch: useBackgroundHatchMock,
}));

mock.module("@/domains/onboarding/research-runner", () => ({
  useResearchRunner: () => researchRunner,
}));

mock.module("@/domains/onboarding/send-research-correction", () => ({
  sendResearchCorrection: async () => {},
}));

const applyPersonalityMock = mock(async (_options: unknown) => {});

mock.module("@/domains/onboarding/apply-personality", () => ({
  applyPersonality: applyPersonalityMock,
}));

mock.module("@/domains/onboarding/lets-chat-kickoff", () => ({
  buildLetsChatKickoffMessage: () => "kickoff",
}));

mock.module("@/domains/onboarding/funnel-events", () => ({
  emitResearchOnboardingStepCompleted: () => {},
  RESEARCH_ONBOARDING_FUNNEL_STEPS: new Proxy(
    {},
    { get: () => ({ stepName: "step", stepIndex: 0 }) },
  ),
}));

mock.module("@/utils/browser-timezone", () => ({
  getBrowserTimezone: () => "UTC",
}));

mock.module("@/stores/onboarding-focus-store", () => ({
  useOnboardingFocusStore: {
    use: {
      enterFocus: () => noop,
      exitFocus: () => noop,
      setPendingAvatarTraits: () => noop,
      setPendingAvatarVoice: () => noop,
      requestSidebarCollapse: () => noop,
    },
  },
}));

mock.module("@/domains/onboarding/established-assistant", () => ({
  checkEstablishedAssistant: checkEstablishedAssistantMock,
  FRESH_ASSISTANT_CHECK: { established: false, assistantName: null },
}));

/* The handoff's post-establishment recheck re-fetches the assistant over the
   same-origin /v1 — stubbed: the verdict it would refresh is what these tests
   drive through the established-assistant mock above. */
const assistantQueries = await import("@/assistant/queries");
mock.module("@/assistant/queries", () => ({
  ...assistantQueries,
  recheckAssistant: async () => undefined,
}));

mock.module("@/domains/onboarding/screens/research-onboarding-screen", () => ({
  ResearchOnboardingScreen: (props: {
    onSubmit: (values: unknown) => void;
  }) => (
    <>
      <button
        type="button"
        data-testid="form-submit"
        onClick={() =>
          props.onSubmit({
            firstName: "Alice",
            lastName: "Example",
            role: "Engineer",
            hobbies: [],
          })
        }
      >
        submit
      </button>
      <button
        type="button"
        data-testid="form-submit-name-only"
        onClick={() =>
          props.onSubmit({
            firstName: "Alice",
            lastName: "",
            role: "",
            hobbies: [],
          })
        }
      >
        submit name only
      </button>
    </>
  ),
}));

mock.module("@/domains/onboarding/screens/give-me-a-face-screen", () => ({
  GiveMeAFaceScreen: () => <div data-testid="face-step" />,
}));

mock.module("@/domains/onboarding/screens/introduction-screen", () => ({
  IntroductionScreen: () => <div data-testid="intro-step" />,
}));

mock.module("@/domains/onboarding/screens/intro-pitch-steps", () => ({
  PitchStep: () => <div data-testid="pitch-step" />,
}));

mock.module("@/domains/onboarding/screens/integration-step", () => ({
  IntegrationStep: () => <div data-testid="integration-step" />,
}));

// Renders the real step's contract: sliders that write back through
// `onValueChange`, and a continue that fires the one-shot persona apply.
mock.module("@/domains/onboarding/screens/create-personality-step", () => ({
  CreatePersonalityStep: (props: {
    onValueChange: (axisId: string, value: number) => void;
    onContinue: () => void;
  }) => (
    <div data-testid="personality-step">
      <button
        type="button"
        data-testid="personality-slide"
        onClick={() => props.onValueChange("warmth", 80)}
      >
        slide
      </button>
      <button
        type="button"
        data-testid="personality-continue"
        onClick={props.onContinue}
      >
        continue
      </button>
    </div>
  ),
}));

mock.module("@/domains/onboarding/screens/research-result-steps", () => ({
  // Surfaces the `ready` gate so a test can pin when the carousel is allowed to
  // advance out of the loading state.
  LookingYouUpStep: (props: { ready: boolean }) => (
    <div data-testid="looking-step" data-ready={String(props.ready)} />
  ),
  // Renders the real step's contract: `onDone` fires only once `ready` holds.
  // The button stands in for the step's closing-line timer, so a test can pin
  // when the parent releases the handoff.
  FinishingUpStep: (props: { ready: boolean; onDone: () => void }) => (
    <div data-testid="finishing-step">
      <button
        type="button"
        data-testid="finishing-done"
        disabled={!props.ready}
        onClick={() => {
          if (!props.ready) {
            return;
          }
          props.onDone();
        }}
      >
        Done
      </button>
    </div>
  ),
  ResearchResultsStep: () => <div data-testid="results-step" />,
  SuggestionsStep: () => <div data-testid="suggestions-step" />,
}));

mock.module("@/domains/onboarding/screens/existing-assistant-step", () => ({
  ExistingAssistantStep: (props: {
    assistantName: string | null;
    onKeep?: () => void;
  }) => (
    <>
      <div data-testid="existing-step">{props.assistantName ?? "unknown"}</div>
      <button type="button" data-testid="existing-keep" onClick={props.onKeep}>
        Keep
      </button>
    </>
  ),
}));

mock.module(
  "@/domains/onboarding/components/onboarding-toned-backdrop",
  () => ({
    OnboardingTonedBackdrop: () => <div data-testid="toned-backdrop" />,
  }),
);

mock.module("@/domains/onboarding/hooks/use-onboarding-stage-size", () => ({
  OnboardingStageSizeProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

let desktopAppPlatform: "macos" | "windows" = "macos";

mock.module("@/runtime/desktop-app-platform", () => ({
  useDesktopAppPlatform: () => desktopAppPlatform,
}));

const { ResearchOnboardingRoute } =
  await import("@/domains/onboarding/pages/research-onboarding-route");

/* The route reads the query client directly (post-hatch invalidations) —
   renders ride a per-test provider instead of mocking the client seam. */
function TestQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function routeElement() {
  return (
    <TestQueryProvider>
      <ResearchOnboardingRoute />
    </TestQueryProvider>
  );
}

function postFormSnapshot(
  overrides: Partial<ResearchOnboardingSnapshot> = {},
): ResearchOnboardingSnapshot {
  return {
    step: "looking",
    formValues: {
      firstName: "Alice",
      lastName: "Example",
      role: "Engineer",
      hobbies: ["chess"],
    },
    faceValues: null,
    research: null,
    ...overrides,
  };
}

/**
 * A finished journey: the runner hydrates straight to "done" and
 * resolveResumeStep lands it on the terminal handoff step.
 */
function doneSnapshot(): ResearchOnboardingSnapshot {
  return postFormSnapshot({
    step: "suggestions",
    research: {
      status: "done",
      claims: [],
      droppedClaims: [],
      suggestions: [],
      installedPlugins: [],
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  adoptExistingAssistant = false;
  desktopAppPlatform = "macos";
  hasCloudSession = true;
  cloudSessionSettled = true;
  researchStatus = "idle";
  installedPlugins = [];
  establishedResult = { established: false, assistantName: null };
  establishedCheckGate = null;
  releaseEstablishedCheck = () => {};
  searchParams.delete("post_checkout");
  backgroundHatch.error = null;
  backgroundHatch.ready = true;
  backgroundHatch.assistantId = "asst-1";
  awaitHatchReady = async () => "asst-1";
  onRetryHatch = () => {};
  navigateMock.mockClear();
  startResearchMock.mockClear();
  hydrateResearchMock.mockClear();
  resetResearchMock.mockClear();
  checkEstablishedAssistantMock.mockClear();
  useBackgroundHatchMock.mockClear();
  retryHatchMock.mockClear();
  reinstallPluginsMock.mockClear();
  applyPersonalityMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("ResearchOnboardingRoute resume guard", () => {
  test("a restored post-form snapshot diverts to the decision screen when the assistant is established", async () => {
    establishedResult = { established: true, assistantName: "Viper" };
    writeResearchSnapshot(ASSISTANT_ID, postFormSnapshot());

    render(routeElement());

    await waitFor(() =>
      expect(screen.getByTestId("existing-step")).toBeTruthy(),
    );
    // Named for the assistant it protects, and — the crux of the fix — the
    // research turn was never re-fired against the established assistant.
    expect(screen.getByTestId("existing-step").textContent).toBe("Viper");
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  test("a restored post-form snapshot resumes research when the assistant is fresh", async () => {
    establishedResult = { established: false, assistantName: null };
    writeResearchSnapshot(ASSISTANT_ID, postFormSnapshot());

    render(routeElement());

    await waitFor(() => expect(startResearchMock).toHaveBeenCalledTimes(1));
    // No guard flash for a genuinely-new assistant; it resumes mid-flow.
    expect(screen.queryByTestId("existing-step")).toBeNull();
    expect(screen.getByTestId("looking-step")).toBeTruthy();
  });

  test("submitting the form still diverts to the decision screen when established", async () => {
    establishedResult = { established: true, assistantName: "Viper" };
    // No snapshot: a fresh visit lands on the form.
    render(routeElement());

    fireEvent.click(await screen.findByTestId("form-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("existing-step")).toBeTruthy(),
    );
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  // A completed snapshot is NOT idle, so the resume effect must still consult
  // the established-assistant guard: otherwise a done journey walks straight
  // into the chat handoff against an assistant that already has a life.
  test("a restored completed snapshot diverts to the decision screen when the assistant is established", async () => {
    establishedResult = { established: true, assistantName: "Viper" };
    researchStatus = "done";
    writeResearchSnapshot(ASSISTANT_ID, doneSnapshot());

    render(routeElement());

    await waitFor(() =>
      expect(screen.getByTestId("existing-step")).toBeTruthy(),
    );
    expect(screen.getByTestId("existing-step").textContent).toBe("Viper");
    // A hydrated "done" journey never re-fires research either way.
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  test("a restored completed snapshot resumes without the guard when the assistant is fresh", async () => {
    establishedResult = { established: false, assistantName: null };
    researchStatus = "done";
    writeResearchSnapshot(ASSISTANT_ID, doneSnapshot());

    render(routeElement());

    // personalityEnabled → the suggestions step renders the chat handoff.
    await waitFor(() =>
      expect(screen.getByTestId("finishing-step")).toBeTruthy(),
    );
    // A fresh verdict must not divert, and a done journey never re-fires.
    expect(screen.queryByTestId("existing-step")).toBeNull();
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  // The completed snapshot lands on the terminal handoff synchronously, but the
  // established check settles asynchronously. Until the verdict lands the chat
  // handoff must stay held — otherwise it races past the guard, clears
  // the snapshot, and navigates away before `setStep("existing")` can divert.
  test("holds the chat handoff while a resumed done journey awaits the guard, then diverts when established", async () => {
    armDelayedEstablishedCheck();
    establishedResult = { established: true, assistantName: "Viper" };
    researchStatus = "done";
    writeResearchSnapshot(ASSISTANT_ID, doneSnapshot());

    render(routeElement());

    // The terminal step is on screen, but the guard hasn't settled → handoff held.
    await waitFor(() =>
      expect(screen.getByTestId("finishing-done")).toBeTruthy(),
    );
    expect(
      (screen.getByTestId("finishing-done") as HTMLButtonElement).disabled,
    ).toBe(true);

    // Triggering the held handoff does nothing: no handoff navigation, snapshot intact.
    fireEvent.click(screen.getByTestId("finishing-done"));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(readResearchSnapshot(ASSISTANT_ID)).not.toBeNull();

    // Releasing an established verdict still diverts to the keep/redo screen.
    releaseEstablishedCheck();
    await waitFor(() =>
      expect(screen.getByTestId("existing-step")).toBeTruthy(),
    );
    expect(screen.getByTestId("existing-step").textContent).toBe("Viper");
    expect(navigateMock).not.toHaveBeenCalled();
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  test("releases the held handoff once a resumed done journey's guard resolves fresh", async () => {
    armDelayedEstablishedCheck();
    establishedResult = { established: false, assistantName: null };
    researchStatus = "done";
    writeResearchSnapshot(ASSISTANT_ID, doneSnapshot());

    render(routeElement());

    // Held while the verdict is pending.
    await waitFor(() =>
      expect(screen.getByTestId("finishing-done")).toBeTruthy(),
    );
    expect(
      (screen.getByTestId("finishing-done") as HTMLButtonElement).disabled,
    ).toBe(true);

    // A fresh verdict releases the hold — no divert, and the handoff becomes usable.
    releaseEstablishedCheck();
    await waitFor(() =>
      expect(
        (screen.getByTestId("finishing-done") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByTestId("existing-step")).toBeNull();

    // And now clicking it actually hands off to the chat.
    fireEvent.click(screen.getByTestId("finishing-done"));
    await waitFor(() => expect(navigateMock).toHaveBeenCalled());
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  // The completion record: this is the only place the assistant the user just
  // finished onboarding is known, so it is where the stamp has to happen.
  test("handing off to chat stamps the assistant as onboarded", async () => {
    researchStatus = "done";
    writeResearchSnapshot(ASSISTANT_ID, doneSnapshot());
    backgroundHatch.ready = true;
    backgroundHatch.assistantId = "asst-1";

    render(routeElement());

    await waitFor(() =>
      expect(
        (screen.getByTestId("finishing-done") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(readOnboardedAt("asst-1")).toBeUndefined();

    fireEvent.click(screen.getByTestId("finishing-done"));

    await waitFor(() => expect(navigateMock).toHaveBeenCalled());
    expect(readOnboardedAt("asst-1")).toBeTruthy();
  });

  test("keeping an established assistant stamps it too", async () => {
    establishedResult = { established: true, assistantName: "Viper" };
    writeResearchSnapshot(ASSISTANT_ID, postFormSnapshot());
    backgroundHatch.ready = true;
    backgroundHatch.assistantId = "asst-1";

    render(routeElement());
    await waitFor(() =>
      expect(screen.getByTestId("existing-step")).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId("existing-keep"));

    await waitFor(() => expect(readOnboardedAt("asst-1")).toBeTruthy());
  });

  test("parking on the guard from a resume never persists a resumable 'existing' snapshot", async () => {
    establishedResult = { established: true, assistantName: "Viper" };
    writeResearchSnapshot(ASSISTANT_ID, postFormSnapshot());

    render(routeElement());
    await waitFor(() =>
      expect(screen.getByTestId("existing-step")).toBeTruthy(),
    );

    // The parked-on-guard journey clears formValues, so the persistence effect
    // can't write a `step: "existing"` snapshot carrying post-form values — the
    // persisted step stays the pre-guard one.
    expect(readResearchSnapshot(ASSISTANT_ID)?.step).not.toBe("existing");

    // A refresh (fresh mount, same snapshot) re-lands on the keep/redo choice
    // rather than auto-resuming past the guard.
    cleanup();
    render(routeElement());
    await waitFor(() =>
      expect(screen.getByTestId("existing-step")).toBeTruthy(),
    );
    expect(startResearchMock).not.toHaveBeenCalled();
  });
});

describe("ResearchOnboardingRoute empty-details research skip", () => {
  const nameOnly = {
    firstName: "Alice",
    lastName: "",
    role: "",
    hobbies: [] as string[],
  };

  test("a name-only submit hydrates empty results and never starts research", async () => {
    render(routeElement());
    fireEvent.click(await screen.findByTestId("form-submit-name-only"));

    await waitFor(() => expect(screen.getByTestId("face-step")).toBeTruthy());
    expect(startResearchMock).not.toHaveBeenCalled();
    expect(hydrateResearchMock).toHaveBeenCalledWith({
      status: "done",
      claims: [],
      droppedClaims: [],
      suggestions: [],
      installedPlugins: [],
    });
  });

  test("a restored looking snapshot with empty role and hobbies skips the reveal", async () => {
    writeResearchSnapshot(
      ASSISTANT_ID,
      postFormSnapshot({ step: "looking", formValues: nameOnly }),
    );

    render(routeElement());

    await waitFor(() =>
      expect(screen.getByTestId("finishing-step")).toBeTruthy(),
    );
    await waitFor(() =>
      expect(hydrateResearchMock).toHaveBeenCalledWith({
        status: "done",
        claims: [],
        droppedClaims: [],
        suggestions: [],
        installedPlugins: [],
      }),
    );
    expect(screen.queryByTestId("looking-step")).toBeNull();
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  test("a restored snapshot with last name and a role still starts research", async () => {
    writeResearchSnapshot(
      ASSISTANT_ID,
      postFormSnapshot({
        formValues: { ...nameOnly, lastName: "Example", role: "Engineer" },
      }),
    );

    render(routeElement());

    await waitFor(() => expect(startResearchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("looking-step")).toBeTruthy();
  });

  test("a restored snapshot with last name and hobbies still starts research", async () => {
    writeResearchSnapshot(
      ASSISTANT_ID,
      postFormSnapshot({
        formValues: { ...nameOnly, lastName: "Example", hobbies: ["chess"] },
      }),
    );

    render(routeElement());

    await waitFor(() => expect(startResearchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("looking-step")).toBeTruthy();
  });

  test("a restored snapshot with role and hobbies but no last name skips research", async () => {
    writeResearchSnapshot(
      ASSISTANT_ID,
      postFormSnapshot({
        step: "looking",
        formValues: { ...nameOnly, role: "Engineer", hobbies: ["chess"] },
      }),
    );

    render(routeElement());

    await waitFor(() =>
      expect(screen.getByTestId("finishing-step")).toBeTruthy(),
    );
    expect(startResearchMock).not.toHaveBeenCalled();
  });
});

// Retrying the hatch must restart everything that already resolved against the
// dead one: the established-assistant verdict (otherwise it stays fail-open)
// from the rejected `awaitReady`), a research turn that settled "error" while
// holding its subject key (otherwise an identical resubmit dedupes to a no-op),
// the persona apply that swallowed the same rejection behind locked sliders,
// and the restored plugin installs that resolved having installed nothing. The
// retried research turn also keeps the conversation the journey already minted,
// so recovery never posts a second search alongside the first.
describe("ResearchOnboardingRoute hatch retry", () => {
  const HATCH_ERROR = "Failed to start your assistant. Please try again.";

  function failFirstHatch() {
    backgroundHatch.error = HATCH_ERROR;
    awaitHatchReady = () => Promise.reject(new Error("hatch failed"));
  }

  function recoverOnRetry() {
    onRetryHatch = () => {
      backgroundHatch.error = null;
      awaitHatchReady = async () => "asst-1";
    };
  }

  test("re-runs the established-assistant check against the retried hatch", async () => {
    failFirstHatch();
    // The retry recovers an assistant that already has a life.
    establishedResult = { established: true, assistantName: "Viper" };

    render(routeElement());
    await screen.findByRole("alert");
    // The dead hatch never got far enough to ask.
    expect(checkEstablishedAssistantMock).not.toHaveBeenCalled();

    recoverOnRetry();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    fireEvent.click(screen.getByTestId("form-submit"));

    // The gate recomputed against the new attempt, so the submit lands on the
    // keep/redo choice instead of running research + persona writes against an
    // established assistant.
    await waitFor(() =>
      expect(screen.getByTestId("existing-step").textContent).toBe("Viper"),
    );
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  test("re-fires a research turn that died with the hatch", async () => {
    const { rerender } = render(routeElement());
    fireEvent.click(await screen.findByTestId("form-submit"));
    await waitFor(() => expect(startResearchMock).toHaveBeenCalledTimes(1));

    // The hatch dies after the submit: the runner's `awaitAssistantId` rejects
    // and the turn settles "error", still holding the submitted subject key.
    researchStatus = "error";
    backgroundHatch.error = HATCH_ERROR;
    rerender(routeElement());

    recoverOnRetry();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(resetResearchMock).toHaveBeenCalledTimes(1);
    expect(startResearchMock).toHaveBeenCalledTimes(2);
    // Ordering stays the runner's job: the re-fired turn awaits the retried
    // hatch itself rather than the handler awaiting readiness first.
    const refired = startResearchMock.mock.calls[1]?.[0] as {
      awaitAssistantId: () => Promise<string>;
    };
    expect(refired.awaitAssistantId).toBe(backgroundHatch.awaitReady);
  });

  test("does not re-fire a research turn that never errored", async () => {
    const { rerender } = render(routeElement());
    fireEvent.click(await screen.findByTestId("form-submit"));
    await waitFor(() => expect(startResearchMock).toHaveBeenCalledTimes(1));

    // Still running when the hatch failed — the turn is already parked on the
    // runner's own `awaitAssistantId`, so a retry must not double-fire it.
    backgroundHatch.error = HATCH_ERROR;
    rerender(routeElement());

    recoverOnRetry();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(resetResearchMock).not.toHaveBeenCalled();
    expect(startResearchMock).toHaveBeenCalledTimes(1);
  });

  // The runner only mints a conversation AFTER the hatch resolves, so a turn
  // that died with the hatch never made one — the id it re-attaches to is the
  // one a prior session persisted. Re-firing without it posts a second research
  // conversation while the first is still there.
  test("re-attaches the retried turn to the conversation the journey already minted", async () => {
    writeResearchSnapshot(
      ASSISTANT_ID,
      postFormSnapshot({ researchConversationId: "conv-1" }),
    );

    const { rerender } = render(routeElement());
    await waitFor(() => expect(startResearchMock).toHaveBeenCalledTimes(1));
    const resumed = startResearchMock.mock.calls[0]?.[0] as {
      resumeConversationId?: string;
    };
    expect(resumed.resumeConversationId).toBe("conv-1");

    researchStatus = "error";
    backgroundHatch.error = HATCH_ERROR;
    rerender(routeElement());

    recoverOnRetry();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(startResearchMock).toHaveBeenCalledTimes(2);
    const refired = startResearchMock.mock.calls[1]?.[0] as {
      resumeConversationId?: string;
    };
    expect(refired.resumeConversationId).toBe("conv-1");
    // A re-run owns its own installs — the restored-install path is not it.
    expect(reinstallPluginsMock).not.toHaveBeenCalled();
  });

  test("a journey with no research conversation re-fires without one", async () => {
    const { rerender } = render(routeElement());
    fireEvent.click(await screen.findByTestId("form-submit"));
    await waitFor(() => expect(startResearchMock).toHaveBeenCalledTimes(1));

    researchStatus = "error";
    backgroundHatch.error = HATCH_ERROR;
    rerender(routeElement());

    recoverOnRetry();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    const refired = startResearchMock.mock.calls[1]?.[0] as {
      resumeConversationId?: string;
    };
    expect(refired.resumeConversationId).toBeUndefined();
  });

  // A completed snapshot hydrates to "done" and re-enqueues its persisted
  // installs against the hatch. Those catch a dead hatch and resolve having
  // installed nothing while the runner stays "done" — so nothing re-runs them
  // and the handoff promises capabilities that were never materialized.
  test("re-enqueues restored plugin installs that settled against the dead hatch", async () => {
    researchStatus = "done";
    installedPlugins = ["admin-copilot"];
    writeResearchSnapshot(
      ASSISTANT_ID,
      postFormSnapshot({
        step: "suggestions",
        research: {
          status: "done",
          claims: [],
          droppedClaims: [],
          suggestions: [],
          installedPlugins: ["admin-copilot"],
        },
      }),
    );
    failFirstHatch();

    render(routeElement());
    await screen.findByRole("alert");

    recoverOnRetry();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(checkEstablishedAssistantMock).toHaveBeenCalled(),
    );
    expect(reinstallPluginsMock).toHaveBeenCalledTimes(1);
    const [names, awaitAssistantId] = reinstallPluginsMock.mock.calls[0] ?? [];
    expect(names).toEqual(["admin-copilot"]);
    // Ordering stays the runner's job: the installs await the retried hatch
    // themselves rather than the handler awaiting readiness first.
    expect(awaitAssistantId).toBe(backgroundHatch.awaitReady);
    // The restored results stand — only the installs are redone.
    expect(startResearchMock).not.toHaveBeenCalled();
    expect(resetResearchMock).not.toHaveBeenCalled();
  });

  // `applyPersonality` awaits the hatch and swallows its rejection, so a hatch
  // that dies while the user walks the later steps leaves the sliders locked as
  // if the persona had been rewritten — it never was.
  test("re-applies the personality that died with the hatch", async () => {
    writeResearchSnapshot(
      ASSISTANT_ID,
      postFormSnapshot({ step: "personality" }),
    );

    const { rerender } = render(routeElement());
    fireEvent.click(await screen.findByTestId("personality-slide"));
    fireEvent.click(screen.getByTestId("personality-continue"));
    await waitFor(() => expect(applyPersonalityMock).toHaveBeenCalledTimes(1));

    backgroundHatch.error = HATCH_ERROR;
    rerender(routeElement());

    recoverOnRetry();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() => expect(applyPersonalityMock).toHaveBeenCalledTimes(2));
    const reapplied = applyPersonalityMock.mock.calls[1]?.[0] as {
      values: Record<string, number>;
      awaitAssistantId: () => Promise<string>;
    };
    // The user's own choices, against the retried hatch.
    expect(reapplied.values).toEqual({ warmth: 80 });
    expect(reapplied.awaitAssistantId).toBe(backgroundHatch.awaitReady);
  });

  test("does not apply a personality the user never chose", async () => {
    failFirstHatch();
    writeResearchSnapshot(ASSISTANT_ID, postFormSnapshot());

    render(routeElement());
    await screen.findByRole("alert");

    recoverOnRetry();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    // The retry did re-arm what the dead hatch poisoned…
    await waitFor(() =>
      expect(checkEstablishedAssistantMock).toHaveBeenCalled(),
    );
    // …but the sliders were never locked in, so there is no persona write to
    // redo — and an idle turn has no restored installs to re-enqueue either.
    expect(applyPersonalityMock).not.toHaveBeenCalled();
    expect(reinstallPluginsMock).not.toHaveBeenCalled();
  });
});

// The claim-credits step ("integration") promises managed free credits, which
// only a cloud account can hold: a self-hosted onboarding with no platform
// login skips it (LUM-3028).
describe("ResearchOnboardingRoute claim-credits skip", () => {
  test("self-hosted without a cloud session skips the claim-credits step", async () => {
    adoptExistingAssistant = true;
    hasCloudSession = false;
    writeResearchSnapshot(
      ASSISTANT_ID,
      postFormSnapshot({ step: "personality" }),
    );

    render(routeElement());
    fireEvent.click(await screen.findByTestId("personality-continue"));

    // Straight to the research reveal: the calendar steps are skipped for
    // self-hosted too, so nothing renders between.
    await waitFor(() =>
      expect(screen.getByTestId("looking-step")).toBeTruthy(),
    );
    expect(screen.queryByTestId("integration-step")).toBeNull();
  });

  test("self-hosted WITH a cloud session keeps the claim-credits step", async () => {
    adoptExistingAssistant = true;
    hasCloudSession = true;
    writeResearchSnapshot(
      ASSISTANT_ID,
      postFormSnapshot({ step: "personality" }),
    );

    render(routeElement());
    fireEvent.click(await screen.findByTestId("personality-continue"));

    await waitFor(() =>
      expect(screen.getByTestId("integration-step")).toBeTruthy(),
    );
  });

  test("an unsettled cloud-session probe keeps the claim-credits step", async () => {
    adoptExistingAssistant = true;
    hasCloudSession = false;
    cloudSessionSettled = false;
    writeResearchSnapshot(
      ASSISTANT_ID,
      postFormSnapshot({ step: "personality" }),
    );

    render(routeElement());
    fireEvent.click(await screen.findByTestId("personality-continue"));

    // "No session yet" is not an answer: a signed-in user racing the probe
    // must not lose the step to a decision that is never revisited.
    await waitFor(() =>
      expect(screen.getByTestId("integration-step")).toBeTruthy(),
    );
  });

  test("a probe settling absent moves an on-screen claim-credits step to the reveal", async () => {
    adoptExistingAssistant = true;
    hasCloudSession = false;
    cloudSessionSettled = false;
    writeResearchSnapshot(
      ASSISTANT_ID,
      postFormSnapshot({ step: "integration" }),
    );

    const { rerender } = render(routeElement());
    await waitFor(() =>
      expect(screen.getByTestId("integration-step")).toBeTruthy(),
    );

    cloudSessionSettled = true;
    rerender(routeElement());

    await waitFor(() =>
      expect(screen.getByTestId("looking-step")).toBeTruthy(),
    );
  });

  test("a snapshot resuming onto the skipped claim-credits step remaps to the research reveal", async () => {
    adoptExistingAssistant = true;
    hasCloudSession = false;
    writeResearchSnapshot(
      ASSISTANT_ID,
      postFormSnapshot({ step: "integration" }),
    );

    render(routeElement());

    await waitFor(() =>
      expect(screen.getByTestId("looking-step")).toBeTruthy(),
    );
    expect(screen.queryByTestId("integration-step")).toBeNull();
  });
});
