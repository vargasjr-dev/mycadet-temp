import { type IpcRenderer, type IpcRendererEvent } from "electron";

import type { BridgeCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import {
  HELPER_DICTATION_FINALIZED_EVENT,
  HELPER_DICTATION_PARTIAL_EVENT,
  HELPER_DICTATION_SET_PARTIALS,
  HELPER_DICTATION_TRANSCRIBE,
  HELPER_DICTATION_TRANSCRIBED_EVENT,
  HELPER_GET_STATE,
  HELPER_HOTKEY_EVENT,
  HELPER_HOTKEY_REGISTRATION_EVENT,
  HELPER_HOTKEY_SET_VOICE_MODE_CHORD,
  HELPER_PING,
  HELPER_RESTART,
  HELPER_STATE_EVENT,
  type DictationPartialEvent,
  type HelperState,
  type HotkeyEvent,
  type VoiceModeChordRegistrationResult,
  type CadetBridge,
} from "@mycadet/ipc-contract";

const subscribe =
  (ipc: IpcRenderer) =>
  <T>(channel: string) =>
  (callback: (event: T) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: T): void => {
      callback(payload);
    };
    ipc.on(channel, listener);
    return () => {
      ipc.off(channel, listener);
    };
  };

/**
 * The Windows native helper's bridge: dictation plus the global voice mode
 * chord. `hotkey.setModifierHold` is deliberately absent (Windows has no
 * Fn-key contract to build a voice key on); `setVoiceModeChord` registers the
 * voice mode shortcut's bare-modifier chord with the helper's keyboard hook
 * instead.
 */
export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
  ipc: IpcRenderer,
): void => {
  registry.contribute("helper", {
    ping: () => ipc.invoke(HELPER_PING) as Promise<"pong">,
    getState: () => ipc.invoke(HELPER_GET_STATE),
    restart: () => ipc.invoke(HELPER_RESTART),
    onState: subscribe(ipc)<HelperState>(HELPER_STATE_EVENT),
    hotkey: {
      setVoiceModeChord: (activator) =>
        ipc.invoke(
          HELPER_HOTKEY_SET_VOICE_MODE_CHORD,
          activator,
        ) as Promise<VoiceModeChordRegistrationResult>,
      onRegistrationChange: subscribe(ipc)<boolean>(
        HELPER_HOTKEY_REGISTRATION_EVENT,
      ),
      onEvent: subscribe(ipc)<HotkeyEvent>(HELPER_HOTKEY_EVENT),
    },
    dictation: {
      setPartials: (enable, deviceName, pushAudio) =>
        ipc.invoke(
          HELPER_DICTATION_SET_PARTIALS,
          enable,
          deviceName,
          pushAudio,
        ),
      pushAudioChunk: (chunk) => {
        ipc.send("cadet:helper:dictation:audio", chunk);
      },
      onPartial: subscribe(ipc)<DictationPartialEvent>(
        HELPER_DICTATION_PARTIAL_EVENT,
      ),
      onFinalized: subscribe(ipc)<DictationPartialEvent>(
        HELPER_DICTATION_FINALIZED_EVENT,
      ),
      transcribe: (audio) =>
        ipc.invoke(HELPER_DICTATION_TRANSCRIBE, audio),
      onTranscribed: subscribe(ipc)<DictationPartialEvent>(
        HELPER_DICTATION_TRANSCRIBED_EVENT,
      ),
    },
  });
};
