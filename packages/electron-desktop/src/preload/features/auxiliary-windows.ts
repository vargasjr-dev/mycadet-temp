import { type IpcRenderer, type IpcRendererEvent } from "electron";

import type { BridgeCapabilityRegistry } from "../../capability-registry";
import {
  COMMAND_PALETTE_DISMISS,
  COMMAND_PALETTE_OPEN,
  COMMAND_PALETTE_SELECT,
  DICTATION_OVERLAY_GET_STATE,
  DICTATION_OVERLAY_REQUEST_STOP,
  DICTATION_OVERLAY_SET_HIT_REGION,
  DICTATION_OVERLAY_SET_INTERACTIVE,
  DICTATION_OVERLAY_SET_STATE,
  DICTATION_OVERLAY_STATE_EVENT,
  DICTATION_OVERLAY_STOP_REQUESTED,
  POPOUT_OPEN,
  QUICK_INPUT_DISMISS,
  QUICK_INPUT_SUBMIT,
  type DictationOverlayState,
  type CadetBridge,
} from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
  ipc: IpcRenderer,
): void => {
  registry.contribute("quickInput", {
    submit: (message) => ipc.invoke(QUICK_INPUT_SUBMIT, message),
    dismiss: () => ipc.invoke(QUICK_INPUT_DISMISS),
  });
  registry.contribute("commandPalette", {
    open: () => ipc.invoke(COMMAND_PALETTE_OPEN),
    dismiss: () => ipc.invoke(COMMAND_PALETTE_DISMISS),
    select: (command) => ipc.invoke(COMMAND_PALETTE_SELECT, command),
  });
  registry.contribute("dictationOverlay", {
    setState: (state) => {
      ipc.send(DICTATION_OVERLAY_SET_STATE, state);
    },
    onState: (callback) => {
      const listener = (
        _event: IpcRendererEvent,
        state: DictationOverlayState,
      ): void => {
        callback(state);
      };
      ipc.on(DICTATION_OVERLAY_STATE_EVENT, listener);
      return () => {
        ipc.off(DICTATION_OVERLAY_STATE_EVENT, listener);
      };
    },
    getState: () => ipc.invoke(DICTATION_OVERLAY_GET_STATE),
    requestStop: () => {
      ipc.send(DICTATION_OVERLAY_REQUEST_STOP);
    },
    onStopRequested: (callback) => {
      const listener = (): void => {
        callback();
      };
      ipc.on(DICTATION_OVERLAY_STOP_REQUESTED, listener);
      return () => {
        ipc.off(DICTATION_OVERLAY_STOP_REQUESTED, listener);
      };
    },
    setInteractive: (interactive) => {
      ipc.send(DICTATION_OVERLAY_SET_INTERACTIVE, interactive);
    },
    setHitRegion: (region) => {
      ipc.send(DICTATION_OVERLAY_SET_HIT_REGION, region);
    },
  });
  registry.contribute("popout", {
    open: (conversationId) => ipc.invoke(POPOUT_OPEN, conversationId),
  });
};
