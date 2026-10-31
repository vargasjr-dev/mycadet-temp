/**
 * Tests for `VoicePickerSurface`, the inline chat card that hosts the shared
 * managed-voice picker.
 *
 * Load-bearing behavior:
 *   - a cloud assistant gets the fetched voice rows inside the surface card,
 *     scoped by the provider dropdown,
 *   - picking a voice submits no surface action, so auditioning several voices
 *     never fires an assistant turn,
 *   - the height cap lands on the scrolling list, not on the wrapper that also
 *     holds the provider dropdown,
 *   - every settled state without a picker gets a pointer instead, and the
 *     unsettled state gets no card at all: a bordered box with nothing in it is
 *     the one outcome this surface must never produce.
 *
 * The daemon queries, the config PATCH, and audio playback are mocked; the
 * design-library Dropdown is real, driven via its combobox trigger.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { Surface } from "@/domains/chat/types/types";

const ASSISTANT_ID = "asst_1";

mock.module("@mycadet/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

let daemonConfigData: { services: Record<string, unknown> } = {
  services: { tts: { provider: "cadet" } },
};
// Holds the config query in flight, for the "still loading" state.
let configPending = false;
let providersData: { providers: unknown[] } = {
  providers: [
    { id: "cadet", displayName: "Cadet", supportsVoiceSelection: true },
  ],
};
let managedVoicesData: { voices: unknown[]; defaultModel: string | null } = {
  voices: [],
  defaultModel: null,
};
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ttsProvidersGetOptions: () => ({
    queryKey: ["tts-providers-test"],
    queryFn: () => Promise.resolve(providersData),
    initialData: providersData,
  }),
  configGetOptions: () =>
    configPending
      ? {
          queryKey: ["config-get-test"],
          queryFn: () => new Promise(() => {}),
        }
      : {
          queryKey: ["config-get-test"],
          queryFn: () => Promise.resolve(daemonConfigData),
          initialData: daemonConfigData,
        },
  configGetQueryKey: () => ["config-get-test"],
}));

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  assistantsListQueryKey: () => ["assistants", "email-test-listing"],

  // The managed-voices daemon transport is deleted; the picker reads the
  // unscoped cloud catalog through the api SDK now.
  managedSpeechTtsVoicesRetrieveOptions: () => ({
    queryKey: ["tts-managed-voices-test"],
    queryFn: () => Promise.resolve(managedVoicesData),
    initialData: managedVoicesData,
  }),
}));

const configPatchCalls: { path?: unknown; body?: unknown }[] = [];
mock.module("@/generated/daemon/sdk.gen", () => ({
  configPatch: async (opts: { path?: unknown; body?: unknown }) => {
    configPatchCalls.push(opts);
    return { response: { ok: true, status: 200 } };
  },
}));

const { VoicePickerSurface } =
  await import("@/domains/chat/components/surfaces/voice-picker-surface");
const { useResolvedAssistantStore } =
  await import("@/stores/resolved-assistant-store");

const SURFACE: Surface = {
  surfaceId: "surface-voice-1",
  surfaceType: "voice_picker",
  title: "Pick a voice",
  data: {},
};

beforeAll(() => {
  (
    window.HTMLMediaElement.prototype as unknown as {
      play: () => Promise<void>;
    }
  ).play = () => Promise.resolve();
  (
    window.HTMLMediaElement.prototype as unknown as { pause: () => void }
  ).pause = () => {};
});

const onActionCalls: unknown[][] = [];

function renderSurface({
  noAssistant = false,
}: { noAssistant?: boolean } = {}) {
  useResolvedAssistantStore
    .getState()
    .setAssistant(
      noAssistant
        ? null
        : { cloud: "local", assistantId: ASSISTANT_ID, port: 7830 },
    );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <VoicePickerSurface
          surface={SURFACE}
          onAction={(...args) => {
            onActionCalls.push(args);
          }}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Voice rows only; the provider dropdown's own options live in a portal. */
function voiceRows(): HTMLElement[] {
  const list = screen.getByRole("listbox", { name: "Assistant voice" });
  return Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
}

/** The list opens on the current voice's provider; Zeus lives under the other. */
function selectDeepgram() {
  const trigger = document.querySelector<HTMLElement>(
    'button[role="combobox"][aria-label="Voice provider"]',
  );
  if (!trigger) {
    throw new Error("expected the voice provider dropdown trigger");
  }
  fireEvent.click(trigger);
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === "Deepgram");
  if (!option) {
    throw new Error("expected a Deepgram option");
  }
  fireEvent.click(option);
}

function pickZeus() {
  const zeus = voiceRows().find((o) =>
    o.textContent?.includes("Deep, trustworthy"),
  );
  if (!zeus) {
    throw new Error("expected the Zeus option");
  }
  fireEvent.click(zeus);
}

beforeEach(() => {
  configPending = false;
  configPatchCalls.length = 0;
  onActionCalls.length = 0;
  daemonConfigData = { services: { tts: { provider: "cadet" } } };
  providersData = {
    providers: [
      { id: "cadet", displayName: "Cadet", supportsVoiceSelection: true },
    ],
  };
  managedVoicesData = {
    voices: [
      {
        model: "EXAVITQu4vr4xnSDxMaL",
        label: "Sarah",
        description: "American · professional, reassuring, confident",
        sampleUrl: "https://example.test/sarah.mp3",
        source: "elevenlabs",
      },
      {
        model: "aura-2-zeus-en",
        label: "Zeus",
        description: "American · deep, trustworthy, smooth",
        sampleUrl: "https://example.test/zeus.wav",
        source: "deepgram",
      },
    ],
    defaultModel: "EXAVITQu4vr4xnSDxMaL",
  };
});
afterEach(cleanup);

describe("VoicePickerSurface", () => {
  test("renders the fetched voices inside the surface card", () => {
    renderSurface();

    expect(screen.getByText("Pick a voice")).toBeTruthy();
    // Scoped to the current voice's provider, with the dropdown to leave it.
    expect(
      document.querySelector(
        'button[role="combobox"][aria-label="Voice provider"]',
      ),
    ).toBeTruthy();
    const rows = voiceRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.textContent).toContain("Professional, reassuring");
    // Cloud voices bill credits, so the card says so.
    expect(screen.getByText(/Uses Cadet credits/)).toBeTruthy();
  });

  test("the provider dropdown scopes the list to the chosen provider", () => {
    renderSurface();
    selectDeepgram();

    const rows = voiceRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.textContent).toContain("Deep, trustworthy");
  });

  test("the height cap lands on the scrolling list, not on the wrapper", () => {
    renderSurface();

    const list = screen.getByRole("listbox", { name: "Assistant voice" });
    expect(list.className).toContain("max-h-[22rem]");
    // The cap replaces the list's own default rather than nesting inside it.
    expect(list.className).not.toContain("max-h-[60vh]");
    // The wrapper holding the provider dropdown stays unconstrained, so the
    // dropdown can't be scrolled out of the card.
    const wrapper = list.parentElement!;
    expect(wrapper.className).not.toContain("max-h-");
    expect(wrapper.className).not.toContain("overflow-y-auto");
  });

  test("picking a voice submits no surface action", async () => {
    renderSurface();
    selectDeepgram();
    pickZeus();

    // The write is what the card does instead of an action. Waiting for it
    // means the action would have been submitted by now if the card submitted
    // one, and every audition click would cost an assistant turn.
    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(onActionCalls.length).toBe(0);
  });

  test("a BYO assistant gets the Models & Services pointer, not an empty card", () => {
    daemonConfigData = { services: { tts: { provider: "elevenlabs" } } };
    renderSurface();

    expect(screen.queryByRole("listbox")).toBeNull();
    const link = screen.getByRole("link", { name: "Models & Services" });
    expect(link.getAttribute("href")).toBe(
      "/assistant/settings/ai#text-to-speech",
    );
  });

  test("a daemon too old to select voices gets a pointer, not an empty card", () => {
    providersData = {
      providers: [
        { id: "cadet", displayName: "Cadet", supportsVoiceSelection: false },
      ],
    };
    renderSurface();

    expect(screen.queryByRole("listbox")).toBeNull();
    // Managed, so the BYO pointer would be a lie: it gets the plain line.
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/available for this assistant/)).toBeTruthy();
  });

  test("an empty voice catalog gets a pointer, not an empty card", () => {
    managedVoicesData = { voices: [], defaultModel: null };
    renderSurface();

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText(/available for this assistant/)).toBeTruthy();
  });

  test("no assistant gets a pointer, not an empty card", () => {
    renderSurface({ noAssistant: true });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText(/available for this assistant/)).toBeTruthy();
  });

  test("renders no card at all while daemon config is still in flight", () => {
    configPending = true;
    const { container } = renderSurface();

    // Not even the title: the card's own chrome would be an empty box until
    // the queries land.
    expect(container.textContent).toBe("");
    expect(screen.queryByText("Pick a voice")).toBeNull();
  });
});
