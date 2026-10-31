import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

/** The options the voice hook was last handed. */
let voiceHookOptions: ({ enabled?: boolean } | undefined)[] = [];
let catalogAvailable = true;

mock.module("@/components/speech/use-cloud-voice-selection", () => ({
  useCloudVoiceSelection: (options: { enabled?: boolean } = {}) => {
    voiceHookOptions.push(options);
    return {
      available: (options.enabled ?? true) && catalogAvailable,
      isByok: false,
      settled: true,
      voices: [],
      currentModel: "",
      defaultModel: "",
      selectModel: () => undefined,
      selecting: false,
    };
  },
}));

const { useCompanionPickers } =
  await import("@/domains/chat/hooks/use-companion-pickers");
const { useCompanionPopoverStore } =
  await import("@/domains/chat/companion-popover");
const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { useResolvedAssistantStore } =
  await import("@/stores/resolved-assistant-store");

beforeEach(() => {
  voiceHookOptions = [];
  catalogAvailable = true;
  useResolvedAssistantStore.getState().setAssistant(null);
  useLiveVoiceStore.setState({ state: "idle" });
  useCompanionPopoverStore.setState({
    openPicker: null,
    microphones: null,
    voices: null,
    voicesPickable: false,
  });
});

afterEach(() => {
  cleanup();
});

describe("useCompanionPickers", () => {
  /** Welcome and onboarding render the root layout with no assistant. */
  test("runs with no assistant selected", () => {
    expect(() => renderHook(() => useCompanionPickers())).not.toThrow();
    expect(voiceHookOptions.every((o) => (o?.enabled ?? true) === false)).toBe(
      true,
    );
  });

  test("asks for voices only during a call, and says whether there are any", () => {
    useResolvedAssistantStore.setState({ assistant: { cloud: "local", assistantId: "asst-1" } });
    renderHook(() => useCompanionPickers());
    expect(voiceHookOptions.at(-1)?.enabled ?? true).toBe(false);
    expect(useCompanionPopoverStore.getState().voicesPickable).toBe(false);

    act(() => {
      useLiveVoiceStore.setState({ state: "listening" });
    });
    expect(voiceHookOptions.at(-1)?.enabled).toBe(true);
    expect(useCompanionPopoverStore.getState().voicesPickable).toBe(true);
  });

  test("offers no voices for an assistant without a catalog", () => {
    catalogAvailable = false;
    useResolvedAssistantStore.setState({ assistant: { cloud: "local", assistantId: "asst-1" } });
    useLiveVoiceStore.setState({ state: "listening" });

    renderHook(() => useCompanionPickers());

    expect(useCompanionPopoverStore.getState().voicesPickable).toBe(false);
  });

  test("closes an open picker when the call ends", () => {
    useLiveVoiceStore.setState({ state: "listening" });
    useCompanionPopoverStore.setState({ openPicker: "microphones" });
    renderHook(() => useCompanionPickers());

    act(() => {
      useLiveVoiceStore.setState({ state: "idle" });
    });

    expect(useCompanionPopoverStore.getState().openPicker).toBeNull();
  });
});
