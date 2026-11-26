import { ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  CadetBridge,
  VoiceActivityContent,
  VoiceActivityControl,
  VoiceActivityStart,
} from "@mycadet/ipc-contract";

/**
 * The voice-activity bridge: the raw transcript stream and the call
 * controls the companion voice session drives. Every desktop's main
 * process serves these channels (they ride the shared companion window),
 * so the surface ships on all three platforms.
 */
export const voiceActivitySurface: NonNullable<CadetBridge["voiceActivity"]> = {
  start: (state: VoiceActivityStart): void => {
    ipcRenderer.send("cadet:voiceActivity:start", state);
  },
  update: (content: VoiceActivityContent): void => {
    ipcRenderer.send("cadet:voiceActivity:update", content);
  },
  end: (): void => {
    ipcRenderer.send("cadet:voiceActivity:end");
  },
  control: (control: VoiceActivityControl): void => {
    ipcRenderer.send("cadet:voiceActivity:control", control);
  },
  onControl: (callback) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: VoiceActivityControl,
    ) => {
      callback(payload);
    };
    ipcRenderer.on("cadet:voiceActivity:controlEvent", handler);
    return () => {
      ipcRenderer.off("cadet:voiceActivity:controlEvent", handler);
    };
  },
};
