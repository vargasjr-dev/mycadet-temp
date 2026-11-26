import { ipcRenderer, type IpcRendererEvent } from "electron";

import type { BridgeCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import {
  HELPER_APPS_FRONTMOST,
  HELPER_APPS_QUIT,
  HELPER_APPS_RUNNING,
  HELPER_HOTKEY_READ_FRONT_SELECTION,
  HELPER_HOTKEY_SET_CHORDS,
  HELPER_HOTKEY_SET_MODIFIER_HOLD,
  HELPER_INPUT_ACTIVITY_EVENT,
  HELPER_INPUT_SET_ACTIVITY_WATCH,
  type CadetBridge,
  type ChordBinding,
  type ChordRegistrationResult,
  type HotkeyEvent,
  type HotkeySelectionResult,
  type ModifierHold,
} from "@mycadet/ipc-contract";

/**
 * The macOS helper's hotkey flavor and app/activity seams: the helper
 * watches the raw keyboard, so the voice key rides a modifier hold and the
 * chords a call answers register directly. Extends the shared helper
 * feature's surface (ping, state, dictation).
 */
export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  registry.extend("helper", {
    hotkey: {
      setModifierHold: (hold: ModifierHold) =>
        ipcRenderer.invoke(HELPER_HOTKEY_SET_MODIFIER_HOLD, hold),
      setChords: (binding: ChordBinding): Promise<ChordRegistrationResult> =>
        ipcRenderer.invoke(HELPER_HOTKEY_SET_CHORDS, binding),
      readFrontSelection: (): Promise<HotkeySelectionResult> =>
        ipcRenderer.invoke(HELPER_HOTKEY_READ_FRONT_SELECTION),
      onEvent: (callback) => {
        const handler = (_event: IpcRendererEvent, payload: HotkeyEvent) => {
          callback(payload);
        };
        ipcRenderer.on("cadet:helper:hotkey:event", handler);
        return () => {
          ipcRenderer.off("cadet:helper:hotkey:event", handler);
        };
      },
    },
    apps: {
      running: (bundleIds: readonly string[]): Promise<string[]> =>
        ipcRenderer.invoke(HELPER_APPS_RUNNING, [...bundleIds]),
      quit: (bundleId: string): Promise<boolean> =>
        ipcRenderer.invoke(HELPER_APPS_QUIT, bundleId),
      frontmost: (): Promise<string | null> =>
        ipcRenderer.invoke(HELPER_APPS_FRONTMOST),
    },
    input: {
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
    },
  });
};
