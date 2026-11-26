import { ipcRenderer, type IpcRendererEvent } from "electron";

import type { BridgeCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import type {
  CadetBridge,
  VoiceActivityContent,
  VoiceActivityControl,
  VoiceActivityStart,
} from "@mycadet/ipc-contract";

/** The macOS voice-activity bridge: the raw transcript stream and the
 * call controls the companion voice session drives. */
export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  registry.contribute("voiceActivity", {
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
  });
};
