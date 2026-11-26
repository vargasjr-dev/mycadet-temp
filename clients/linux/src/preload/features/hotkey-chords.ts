import { ipcRenderer, type IpcRendererEvent } from "electron";

import type { BridgeCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import {
  HELPER_HOTKEY_EVENT,
  HELPER_HOTKEY_REGISTRATION_EVENT,
  HELPER_HOTKEY_SET_VOICE_MODE_CHORD,
  type HotkeyEvent,
  type VoiceModeChordRegistrationResult,
  type CadetBridge,
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
 * This platform's helper hotkey flavor: the voice mode shortcut's
 * bare-modifier chord, registered with the helper when a sidecar exists.
 * `hotkey.setModifierHold` is absent — the voice key's hold rides the raw
 * keyboard, which only the macOS helper's monitor provides. Extends the
 * shared helper feature's surface (registry merge).
 */
export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  registry.extend("helper", {
    hotkey: {
      setVoiceModeChord: (activator) =>
        ipcRenderer.invoke(HELPER_HOTKEY_SET_VOICE_MODE_CHORD, activator),
      onRegistrationChange: subscribe<boolean>(
        HELPER_HOTKEY_REGISTRATION_EVENT,
      ),
      onEvent: subscribe<HotkeyEvent>(HELPER_HOTKEY_EVENT),
    },
  });
};
