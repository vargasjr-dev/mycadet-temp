import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  HELPER_DICTATION_FINALIZED_EVENT,
  HELPER_DICTATION_PARTIAL_EVENT,
  HELPER_DICTATION_SET_PARTIALS,
  HELPER_DICTATION_TRANSCRIBE,
  HELPER_DICTATION_TRANSCRIBED_EVENT,
  HELPER_GET_STATE,
  HELPER_PING,
  HELPER_RESTART,
  HELPER_STATE_EVENT,
  type DictationPartialEvent,
  type HelperState,
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
 * The helper surface every desktop platform shares: helper lifecycle plus
 * dictation. The hotkey flavor is platform-specific — Linux and Windows
 * register the voice mode's shortcut chord, macOS holds the raw keyboard
 * for the modifier voice key — so each client's own feature contributes
 * `helper.hotkey` on top of this base.
 */
export const install = (bridge: Partial<CadetBridge>): void => {
  bridge.helper = {
    ping: (): Promise<"pong"> =>
      Promise.resolve(ipcRenderer.invoke(HELPER_PING)),
    getState: (): Promise<HelperState> =>
      Promise.resolve(ipcRenderer.invoke(HELPER_GET_STATE)),
    restart: () => Promise.resolve(ipcRenderer.invoke(HELPER_RESTART)),
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
      onPartial: subscribe<DictationPartialEvent>(
        HELPER_DICTATION_PARTIAL_EVENT,
      ),
      onFinalized: subscribe<DictationPartialEvent>(
        HELPER_DICTATION_FINALIZED_EVENT,
      ),
      transcribe: (audio) =>
        Promise.resolve(ipcRenderer.invoke(HELPER_DICTATION_TRANSCRIBE, audio)),
      onTranscribed: subscribe<DictationPartialEvent>(
        HELPER_DICTATION_TRANSCRIBED_EVENT,
      ),
    },
  };
};
