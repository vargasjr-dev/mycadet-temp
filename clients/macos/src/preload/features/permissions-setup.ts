import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  PERMISSION_GUIDE_CANCEL,
  PERMISSION_SETUP_BEGIN,
  PERMISSION_GUIDE_GET,
  PERMISSION_GUIDE_STATE,
  PERMISSION_GUIDE_READY,
  PERMISSION_GUIDE_DISMISS,
  PERMISSION_GUIDE_DRAG,
  PERMISSION_GUIDE_REVEAL,
  type PermissionGuideState,
  type CadetBridge,
} from "@mycadet/ipc-contract";

/** Optional macOS permission setup and native app drag bridge. */
const createPermissionSetupBridge = (): NonNullable<
  CadetBridge["permissions"]["setup"]
> => ({
  cancel: () => ipcRenderer.send(PERMISSION_GUIDE_CANCEL),
  begin: (kind, source) =>
    ipcRenderer.invoke(PERMISSION_SETUP_BEGIN, kind, source),
  getGuide: () => ipcRenderer.invoke(PERMISSION_GUIDE_GET),
  onGuide: (callback) => {
    const handler = (
      _event: IpcRendererEvent,
      state: PermissionGuideState | null,
    ): void => {
      callback(state);
    };
    ipcRenderer.on(PERMISSION_GUIDE_STATE, handler);
    return () => {
      ipcRenderer.off(PERMISSION_GUIDE_STATE, handler);
    };
  },
  ready: (id, height) => ipcRenderer.send(PERMISSION_GUIDE_READY, id, height),
  dismiss: (id) => ipcRenderer.send(PERMISSION_GUIDE_DISMISS, id),
  startDrag: (id) => ipcRenderer.send(PERMISSION_GUIDE_DRAG, id),
  revealApp: (id) => ipcRenderer.invoke(PERMISSION_GUIDE_REVEAL, id),
});

/**
 * The macOS permission-setup guide (screen recording, accessibility, the
 * drag window). Its handlers exist only in the macOS main process, so the
 * `permissions.setup` seam finishes the shared permissions feature here
 * alone.
 */
export const install = (bridge: Partial<CadetBridge>): void => {
  const permissions = bridge.permissions;
  if (!permissions) {
    // Composition order guarantees the shared permissions feature ran first.
    throw new Error("permission setup requires the shared permissions feature");
  }
  permissions.setup = createPermissionSetupBridge();
};
