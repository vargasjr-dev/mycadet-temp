import { ipcRenderer, type IpcRendererEvent } from "electron";

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

/**
 * The auxiliary-window surfaces: the quick input, the command palette, the
 * dictation overlay, and the conversation popout — each a frame the main
 * process opens and the renderer fills.
 */
export const auxiliaryWindowSurfaces: Pick<
  CadetBridge,
  "quickInput" | "commandPalette" | "dictationOverlay" | "popout"
> = {
  quickInput: {
    submit: (message) => ipcRenderer.invoke(QUICK_INPUT_SUBMIT, message),
    dismiss: () => ipcRenderer.invoke(QUICK_INPUT_DISMISS),
  },
  commandPalette: {
    open: () => ipcRenderer.invoke(COMMAND_PALETTE_OPEN),
    dismiss: () => ipcRenderer.invoke(COMMAND_PALETTE_DISMISS),
    select: (command) => ipcRenderer.invoke(COMMAND_PALETTE_SELECT, command),
  },
  dictationOverlay: {
    setState: (state) => {
      ipcRenderer.send(DICTATION_OVERLAY_SET_STATE, state);
    },
    onState: (callback) => {
      const listener = (
        _event: IpcRendererEvent,
        state: DictationOverlayState,
      ): void => {
        callback(state);
      };
      ipcRenderer.on(DICTATION_OVERLAY_STATE_EVENT, listener);
      return () => {
        ipcRenderer.off(DICTATION_OVERLAY_STATE_EVENT, listener);
      };
    },
    getState: () => ipcRenderer.invoke(DICTATION_OVERLAY_GET_STATE),
    requestStop: () => {
      ipcRenderer.send(DICTATION_OVERLAY_REQUEST_STOP);
    },
    onStopRequested: (callback) => {
      const listener = (): void => {
        callback();
      };
      ipcRenderer.on(DICTATION_OVERLAY_STOP_REQUESTED, listener);
      return () => {
        ipcRenderer.off(DICTATION_OVERLAY_STOP_REQUESTED, listener);
      };
    },
    setInteractive: (interactive) => {
      ipcRenderer.send(DICTATION_OVERLAY_SET_INTERACTIVE, interactive);
    },
    setHitRegion: (region) => {
      ipcRenderer.send(DICTATION_OVERLAY_SET_HIT_REGION, region);
    },
  },
  popout: {
    open: (conversationId) => ipcRenderer.invoke(POPOUT_OPEN, conversationId),
  },
};
