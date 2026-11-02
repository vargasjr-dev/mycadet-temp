/**
 * Behavioral tests for the hatching screen's app-native port: the local arm
 * rides the shell's operator route (hatch → resolution poll → handoff), and
 * the cloud arm rides the app's own hatch API.
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

import { NEW_ASSISTANT_PARAM } from "@app/domains/onboarding/onboarding-destination";
import { routes } from "@app/utils/routes";

// --- Mutable per-test state, reset in beforeEach ------------------------------

const navigateMock = mock((_to: string, _opts?: unknown) => {});
let searchParams = new URLSearchParams();

const apiActual = await import("@app/assistant/api");
type HatchResult = Awaited<ReturnType<typeof apiActual.hatchAssistant>>;
const hatchAssistantMock = mock(
  async (): Promise<HatchResult> => ({
    ok: true as const,
    status: 201,
    data: { id: "asst-1", name: "Cadet 1" },
  }),
);

const hatchLocalAssistantMock = mock(async (_remote?: string) => ({
  ok: true as const,
  assistantId: "local-1",
}));

const resolveActual = await import("@app/assistant/resolve-assistant");
type Resolution = Awaited<ReturnType<typeof resolveActual.resolveAssistant>>;
let resolutionReadyFromCall = 1;
let resolutionCallCount = 0;
const resolveAssistantMock = mock(async (): Promise<Resolution> => {
  resolutionCallCount += 1;
  if (resolutionCallCount >= resolutionReadyFromCall) {
    return {
      status: "ready",
      assistant: {
        id: "local-1",
        version: "0.13.0",
        url: "http://localhost:5173/assistant/",
      },
    };
  }
  return { status: "notReady" };
});

const writeSelectionMock = mock((_id: string) => {});

// --- Mocks --------------------------------------------------------------------

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams, mock(() => {})],
}));

const operationsActual = await import("@app/assistant/operations");
mock.module("@app/assistant/operations", () => ({
  ...operationsActual,
  hatchAssistant: hatchLocalAssistantMock,
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

mock.module("@app/assistant/api", () => ({
  ...apiActual,
  hatchAssistant: hatchAssistantMock,
}));

const { HatchingScreen } =
  await import("@app/domains/onboarding/pages/hatching-screen");

describe("hatching screen", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    hatchAssistantMock.mockClear();
    hatchLocalAssistantMock.mockClear();
    resolveAssistantMock.mockClear();
    writeSelectionMock.mockClear();
    seedHatchAvatarMock.mockClear();
    resolutionCallCount = 0;
    resolutionReadyFromCall = 1;
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
    expect(hatchLocalAssistantMock).not.toHaveBeenCalled();
  });

  test("the local hatch polls the resolution endpoint then hands off to research with the hosting + assistant", async () => {
    searchParams = new URLSearchParams("hosting=local");
    resolutionReadyFromCall = 2;
    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(hatchLocalAssistantMock).toHaveBeenCalledWith(undefined);
    expect(writeSelectionMock).toHaveBeenCalledWith("local-1");
    // The resolution answered notReady once, so the wait loop polled again.
    expect(resolutionCallCount).toBe(2);
    expect(navigateMock).toHaveBeenCalledWith(
      `${routes.onboarding.research}?hosting=local&assistant=local-1`,
      { replace: true },
    );
  });

  test("the cloud hatch hands off to the research flow", async () => {
    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(hatchAssistantMock).toHaveBeenCalled();
    // The hatch avatar re-home: the freshly hatched assistant's id seeds the
    // random traits on the scoped surface (fire-and-forget, never awaited).
    expect(seedHatchAvatarMock).toHaveBeenCalledWith(
      "asst-1",
      expect.objectContaining({ bodyShape: expect.any(String) }),
    );
    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.research, {
      replace: true,
    });
  });

  test("a failed cloud hatch surfaces the detail and retry re-fires the hatch", async () => {
    hatchAssistantMock.mockImplementationOnce(async () => ({
      ok: false as const,
      status: 503,
      error: { detail: "hatching is unavailable" },
    }));
    render(<HatchingScreen />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByText("hatching is unavailable")).toBeDefined();

    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(hatchAssistantMock).toHaveBeenCalledTimes(2);
    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.research, {
      replace: true,
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

  test("back exits a cloud walk to research with the new-assistant marker", async () => {
    searchParams = new URLSearchParams("fail=1");
    render(<HatchingScreen />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    fireEvent.click(screen.getByText("Back"));
    expect(navigateMock).toHaveBeenCalledWith(
      `${routes.onboarding.research}?${NEW_ASSISTANT_PARAM}=1`,
      { replace: true },
    );
  });
});
