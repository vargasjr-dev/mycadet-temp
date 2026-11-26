import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  HELPER_APPS_FRONTMOST,
  HELPER_APPS_QUIT,
  HELPER_APPS_RUNNING,
  HELPER_DICTATION_FINALIZED_EVENT,
  HELPER_DICTATION_PARTIAL_EVENT,
  HELPER_DICTATION_SET_PARTIALS,
  HELPER_DICTATION_TRANSCRIBE,
  HELPER_DICTATION_TRANSCRIBED_EVENT,
  HELPER_GET_STATE,
  HELPER_HOTKEY_EVENT,
  HELPER_HOTKEY_READ_FRONT_SELECTION,
  HELPER_HOTKEY_REGISTRATION_EVENT,
  HELPER_HOTKEY_SET_CHORDS,
  HELPER_HOTKEY_SET_MODIFIER_HOLD,
  HELPER_HOTKEY_SET_VOICE_MODE_CHORD,
  HELPER_INPUT_ACTIVITY_EVENT,
  HELPER_INPUT_SET_ACTIVITY_WATCH,
  HELPER_PING,
  HELPER_RESTART,
  HELPER_STATE_EVENT,
  type CadetBridge,
  type ChordBinding,
  type ChordRegistrationResult,
  type DictationPartialEvent,
  type HelperState,
  type HotkeyEvent,
  type HotkeySelectionResult,
  type ModifierHold,
} from "@mycadet/ipc-contract";

const subscribe =
  <T>(channel: string) =>
  (callback: (event: T) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: T): void => {
      callback(payload);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.off(channel, listener);
    };
  };

/**
 * The helper surface every desktop platform shares: helper lifecycle plus
 * dictation. The hotkey flavor is platform-specific, so the composition
 * adds `hotkey` (and, on macOS, `apps` and `input`) on top of this base.
 */
export const helperSurface: CadetBridge["helper"] = {
  ping: (): Promise<"pong"> => ipcRenderer.invoke(HELPER_PING),
  getState: (): Promise<HelperState> => ipcRenderer.invoke(HELPER_GET_STATE),
  restart: () => ipcRenderer.invoke(HELPER_RESTART),
  onState: subscribe<HelperState>(HELPER_STATE_EVENT),
  dictation: {
    setPartials: (enable, deviceName, pushAudio) =>
      ipcRenderer.invoke(
        HELPER_DICTATION_SET_PARTIALS,
        enable,
        deviceName,
        pushAudio,
      ),
    pushAudioChunk: (chunk) => {
      ipcRenderer.send("cadet:helper:dictation:audio", chunk);
    },
    onPartial: subscribe<DictationPartialEvent>(HELPER_DICTATION_PARTIAL_EVENT),
    onFinalized: subscribe<DictationPartialEvent>(
      HELPER_DICTATION_FINALIZED_EVENT,
    ),
    transcribe: (audio) =>
      ipcRenderer.invoke(HELPER_DICTATION_TRANSCRIBE, audio),
    onTranscribed: subscribe<DictationPartialEvent>(
      HELPER_DICTATION_TRANSCRIBED_EVENT,
    ),
  },
};

/**
 * macOS's hotkey flavor: the helper watches the raw keyboard, so the voice
 * key rides a modifier hold and the chords a call answers register directly.
 */
export const helperHotkeyHold: NonNullable<CadetBridge["helper"]["hotkey"]> = {
  onEvent: subscribe<HotkeyEvent>(HELPER_HOTKEY_EVENT),
  setModifierHold: (hold: ModifierHold) =>
    ipcRenderer.invoke(HELPER_HOTKEY_SET_MODIFIER_HOLD, hold),
  setChords: (binding: ChordBinding): Promise<ChordRegistrationResult> =>
    ipcRenderer.invoke(HELPER_HOTKEY_SET_CHORDS, binding),
  readFrontSelection: (): Promise<HotkeySelectionResult> =>
    ipcRenderer.invoke(HELPER_HOTKEY_READ_FRONT_SELECTION),
};

/**
 * The Linux and Windows hotkey flavor: the helper serves the voice mode's
 * bare-modifier chord registered through the sidecar.
 */
export const helperHotkeyChord: NonNullable<CadetBridge["helper"]["hotkey"]> = {
  onEvent: subscribe<HotkeyEvent>(HELPER_HOTKEY_EVENT),
  setVoiceModeChord: (activator) =>
    ipcRenderer.invoke(HELPER_HOTKEY_SET_VOICE_MODE_CHORD, activator),
  onRegistrationChange: subscribe<boolean>(HELPER_HOTKEY_REGISTRATION_EVENT),
};

/**
 * The helper's app seam: the dictation editor's picker needs the running
 * editors and can quit or read the frontmost one. macOS only — the other
 * helpers have no bundle-id notion.
 */
export const helperApps: NonNullable<CadetBridge["helper"]["apps"]> = {
  running: (bundleIds: readonly string[]): Promise<string[]> =>
    ipcRenderer.invoke(HELPER_APPS_RUNNING, [...bundleIds]),
  quit: (bundleId: string): Promise<boolean> =>
    ipcRenderer.invoke(HELPER_APPS_QUIT, bundleId),
  frontmost: (): Promise<string | null> =>
    ipcRenderer.invoke(HELPER_APPS_FRONTMOST),
};

/** The helper's input-activity seam, macOS only (the raw keyboard monitor). */
export const helperInput: NonNullable<CadetBridge["helper"]["input"]> = {
  setActivityWatch: (enable: boolean): Promise<boolean> =>
    ipcRenderer.invoke(HELPER_INPUT_SET_ACTIVITY_WATCH, enable),
  onActivity: (callback: () => void): (() => void) => {
    const handler = () => {
      callback();
    };
    ipcRenderer.on(HELPER_INPUT_ACTIVITY_EVENT, handler);
    return () => {
      ipcRenderer.off(HELPER_INPUT_ACTIVITY_EVENT, handler);
    };
  },
};
