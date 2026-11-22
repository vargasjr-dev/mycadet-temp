/**
 * Behavioral tests for the hatching screen's app-native port: the hatch rides
 * the shell's one operator route — POST /v1/assistants/hatch with the funnel's
 * hosting choice as the remote param (local, docker, cloud) — then the
 * resolution poll, then the assistant-page handoff.
 *
 * The screen keeps module-level hatch guards, so every test drives the flow to
 * a genuine completion (which releases them) to stay isolated. Self-contained
 * mocks — run this file solo (`mock.module` leaks across a shared `bun test`
 * run).
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { routes } from "@app/utils/routes";

// --- Mutable per-test state, reset in beforeEach ------------------------------

const navigateMock = mock((_to: string, _opts?: unknown) => {});
let searchParams = new URLSearchParams();

const hatchAssistantMock = mock(
  async (
    _remote?: string,
  ): Promise<
    { ok: true; assistantId: string } | { ok: false; error: string }
  > => ({
    ok: true as const,
    assistantId: "local-1",
  }),
);

const resolveActual = await import("@app/assistant/resolve-assistant");
type Resolution = Awaited<ReturnType<typeof resolveActual.resolveAssistant>>;
let resolutionReadyFromCall = 1;
let resolutionCallCount = 0;
function defaultResolutionBehavior(): Promise<Resolution> {
  resolutionCallCount += 1;
  if (resolutionCallCount >= resolutionReadyFromCall) {
    return Promise.resolve({
      status: "ready",
      assistant: {
        id: "local-1",
        version: "0.13.0",
      },
    });
  }
  return Promise.resolve({ status: "notReady" });
}
const resolveAssistantMock = mock(defaultResolutionBehavior);

const writeSelectionMock = mock((_id: string) => {});

// --- Mocks --------------------------------------------------------------------

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams, mock(() => {})],
}));

const operationsActual = await import("@app/assistant/operations");
mock.module("@app/assistant/operations", () => ({
  ...operationsActual,
  hatchAssistant: hatchAssistantMock,
}));
mock.module("@app/assistant/resolve-assistant", () => ({
  ...resolveActual,
  resolveAssistant: resolveAssistantMock,
}));

const selectionActual =
  await import("@app/assistant/selected-assistant-storage");
mock.module("@app/assistant/selected-assistant-storage", () => ({
  ...selectionActual,
  writeSelectedAssistantId: writeSelectionMock,
}));

// Avatar seeding is fire-and-forget and hits the scoped surface; the suite
// pins it as observed-no-op so no test leaks a network attempt.
const seedHatchAvatarMock = mock((_id: string, _traits: unknown) => {});
mock.module("@app/assistant/avatar-traits", () => ({
  seedHatchAvatar: seedHatchAvatarMock,
}));

// The avatar svg compose is real by default; a test can force the null path
// to pin the broken-image guard. The original function is captured before the
// patch — the module's own binding is the mock once patched, so re-entering
// through it would recurse to death.
const compositorActual = await import("@app/utils/avatar-svg-compositor");
const realComposeSvg = compositorActual.composeSvg;
const realComposeSvgFromDefinitions =
  compositorActual.composeSvgFromDefinitions;
let composeSvgOverride: typeof compositorActual.composeSvg | null = null;
mock.module("@app/utils/avatar-svg-compositor", () => ({
  composeSvg: (
    ...args: Parameters<typeof compositorActual.composeSvg>
  ): string | null =>
    composeSvgOverride ? composeSvgOverride(...args) : realComposeSvg(...args),
  composeSvgFromDefinitions: realComposeSvgFromDefinitions,
}));

const { HatchingScreen } =
  await import("@app/domains/onboarding/pages/hatching-screen");

describe("hatching screen", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    hatchAssistantMock.mockClear();
    resolveAssistantMock.mockClear();
    writeSelectionMock.mockClear();
    seedHatchAvatarMock.mockClear();
    resolutionCallCount = 0;
    resolutionReadyFromCall = 1;
    resolveAssistantMock.mockImplementation(defaultResolutionBehavior);
    searchParams = new URLSearchParams();
  });

  afterEach(() => {
    cleanup();
  });

  test("the fail preview renders the error UI without hatching", async () => {
    searchParams = new URLSearchParams("fail=1");
    render(<HatchingScreen />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(hatchAssistantMock).not.toHaveBeenCalled();
  });

  test("a composed avatar renders as a data-url image", () => {
    // The happy path pins the shape the broken-image guard protects: a real
    // src, never an empty one.
    searchParams = new URLSearchParams("fail=1");
    const view = render(<HatchingScreen />);

    const img = view.container.querySelector("img");
    expect(img).toBeDefined();
    expect(
      (img as HTMLImageElement)
        .getAttribute("src")
        ?.startsWith("data:image/svg+xml"),
    ).toBe(true);
  });

  test("a failed compose renders a placeholder, never an empty-src image", () => {
    // Chromium paints a broken-image icon for `src=""` — the icon Bartolo
    // reported near the bottom of a white screen. A compose that cannot
    // resolve renders a placeholder instead.
    searchParams = new URLSearchParams("fail=1");
    composeSvgOverride = () => null;
    const view = render(<HatchingScreen />);

    expect(view.container.querySelector("img")).toBeNull();
    composeSvgOverride = null;
  });

  test("the local hatch polls the resolution endpoint then hands off to the assistant page with the hatched assistant in state", async () => {
    searchParams = new URLSearchParams("hosting=local");
    resolutionReadyFromCall = 2;
    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(hatchAssistantMock).toHaveBeenCalledWith("local");
    expect(writeSelectionMock).toHaveBeenCalledWith("local-1");
    // The resolution answered notReady once, so the wait loop polled again.
    expect(resolutionCallCount).toBe(2);
    expect(navigateMock).toHaveBeenCalledWith(routes.assistant, {
      replace: true,
      state: { assistantSelection: { id: "local-1" } },
    });
  });

  test("a resolution that says unauthenticated renders the error screen and stops asking", async () => {
    searchParams = new URLSearchParams("hosting=local");
    resolveAssistantMock.mockImplementation(async () => {
      resolutionCallCount += 1;
      return { status: "unauthenticated" } as Resolution;
    });
    render(<HatchingScreen />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(hatchAssistantMock).toHaveBeenCalledWith("local");
    // The 401 is fatal: one query, no polling, no handoff.
    expect(resolutionCallCount).toBe(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("the docker hatch passes the docker remote and carries the hatched assistant to the assistant page", async () => {
    searchParams = new URLSearchParams("hosting=docker");
    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(hatchAssistantMock).toHaveBeenCalledWith("docker");
    expect(navigateMock).toHaveBeenCalledWith(routes.assistant, {
      replace: true,
      state: { assistantSelection: { id: "local-1" } },
    });
  });

  test("the cloud hatch passes the cloud remote and carries the hatched assistant to the assistant page", async () => {
    searchParams = new URLSearchParams("hosting=cloud");
    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(hatchAssistantMock).toHaveBeenCalledWith("cloud");
    expect(writeSelectionMock).toHaveBeenCalledWith("local-1");
    // The hatch avatar re-home: the freshly hatched assistant's id seeds the
    // random traits on the scoped surface (fire-and-forget, never awaited).
    expect(seedHatchAvatarMock).toHaveBeenCalledWith(
      "local-1",
      expect.objectContaining({ bodyShape: expect.any(String) }),
    );
    // Hosting-agnostic handoff: the id the hatch resolved rides the state,
    // the route stays bare.
    expect(navigateMock).toHaveBeenCalledWith(routes.assistant, {
      replace: true,
      state: { assistantSelection: { id: "local-1" } },
    });
  });

  test("a failed cloud hatch surfaces the detail and retry re-fires the hatch", async () => {
    hatchAssistantMock.mockImplementationOnce(async () => ({
      ok: false as const,
      error: "hatching is unavailable",
    }));
    searchParams = new URLSearchParams("hosting=cloud");
    render(<HatchingScreen />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByText("hatching is unavailable")).toBeDefined();

    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(hatchAssistantMock).toHaveBeenCalledTimes(2);
    expect(navigateMock).toHaveBeenCalledWith(routes.assistant, {
      replace: true,
      state: { assistantSelection: { id: "local-1" } },
    });
  });

  test("back exits a local walk to hosting", async () => {
    searchParams = new URLSearchParams("fail=1&hosting=local");
    render(<HatchingScreen />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    fireEvent.click(screen.getByText("Back"));
    expect(navigateMock).toHaveBeenCalledWith(
      routes.account.onboarding.hosting,
      { replace: true },
    );
  });

  test("back exits a cloud walk to hosting like every other walk", async () => {
    searchParams = new URLSearchParams("fail=1");
    render(<HatchingScreen />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    fireEvent.click(screen.getByText("Back"));
    expect(navigateMock).toHaveBeenCalledWith(
      routes.account.onboarding.hosting,
      { replace: true },
    );
  });
});
