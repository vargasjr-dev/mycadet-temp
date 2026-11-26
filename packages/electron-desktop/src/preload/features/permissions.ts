import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  PERMISSIONS_GET_STATE,
  PERMISSIONS_OPEN_SETTINGS,
  PERMISSIONS_QUIT_AND_REOPEN,
  PERMISSIONS_REQUEST,
  PERMISSIONS_STATE_EVENT,
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

export const install = (bridge: Partial<CadetBridge>): void => {
  bridge.permissions = {
    getState: (): Promise<SystemPermissionsState> =>
      Promise.resolve(ipcRenderer.invoke(PERMISSIONS_GET_STATE)),
    request: (kind, presentation) =>
      invokeItem(PERMISSIONS_REQUEST, kind, presentation),
    openSettings: (kind) => invokeItem(PERMISSIONS_OPEN_SETTINGS, kind),
    quitAndReopen: (): Promise<void> =>
      Promise.resolve(ipcRenderer.invoke(PERMISSIONS_QUIT_AND_REOPEN)),
    onState: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        state: SystemPermissionsState,
      ) => callback(state);
      ipcRenderer.on(PERMISSIONS_STATE_EVENT, handler);
      return () => ipcRenderer.off(PERMISSIONS_STATE_EVENT, handler);
    },
  };
};
