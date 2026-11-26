import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  PERMISSIONS_GET_STATE,
  PERMISSIONS_OPEN_SETTINGS,
  PERMISSIONS_QUIT_AND_REOPEN,
  PERMISSIONS_REQUEST,
  PERMISSIONS_STATE_EVENT,
  PERMISSION_GUIDE_CANCEL,
  PERMISSION_SETUP_BEGIN,
  PERMISSION_GUIDE_GET,
  PERMISSION_GUIDE_STATE,
  PERMISSION_GUIDE_READY,
  PERMISSION_GUIDE_DISMISS,
  PERMISSION_GUIDE_DRAG,
  PERMISSION_GUIDE_REVEAL,
  type PermissionGuideState,
  type SystemPermissionKind,
  type SystemPermissionStateItem,
  type SystemPermissionsState,
  type CadetBridge,
} from "@mycadet/ipc-contract";

const invokeItem = (
  channel: string,
  kind: SystemPermissionKind,
  presentation?: Parameters<CadetBridge["permissions"]["request"]>[1],
): Promise<SystemPermissionStateItem> =>
  // The optional presentation rides only when the caller sent one, so a
  // main whose handler takes the kind alone sees the same wire shape as
  // before.
  presentation === undefined
    ? Promise.resolve(ipcRenderer.invoke(channel, kind))
    : Promise.resolve(ipcRenderer.invoke(channel, kind, presentation));

/** The permissions surface every desktop platform shares. */
export const createPermissionsSurface = (): CadetBridge["permissions"] => ({
  getState: (): Promise<SystemPermissionsState> =>
    Promise.resolve(ipcRenderer.invoke(PERMISSIONS_GET_STATE)),
  request: (kind, presentation) =>
    invokeItem(PERMISSIONS_REQUEST, kind, presentation),
  openSettings: (kind) => invokeItem(PERMISSIONS_OPEN_SETTINGS, kind),
  quitAndReopen: (): Promise<void> =>
    Promise.resolve(ipcRenderer.invoke(PERMISSIONS_QUIT_AND_REOPEN)),
  onState: (callback) => {
    const handler = (_event: IpcRendererEvent, state: SystemPermissionsState) =>
      callback(state);
    ipcRenderer.on(PERMISSIONS_STATE_EVENT, handler);
    return () => ipcRenderer.off(PERMISSIONS_STATE_EVENT, handler);
  },
});

/**
 * The permission-setup guide (screen recording, accessibility, the drag
 * window). Its handlers exist only in the macOS main process — System
 * Settings accepts native application-bundle drops — so the composition
 * adds the `setup` seam on macOS alone.
 */
export const createPermissionSetupBridge = (): NonNullable<
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
