import { type IpcRenderer, type IpcRendererEvent } from "electron";

import type { BridgeCapabilityRegistry } from "../../capability-registry";
import {
  PERMISSIONS_GET_STATE,
  PERMISSIONS_OPEN_SETTINGS,
  PERMISSIONS_QUIT_AND_REOPEN,
  PERMISSIONS_REQUEST,
  PERMISSIONS_STATE_EVENT,
  TEXT_INSERT,
  TEXT_OPEN_SETTINGS,
  type SystemPermissionKind,
  type SystemPermissionStateItem,
  type SystemPermissionsState,
  type TextInsertionResult,
  type CadetBridge,
} from "@mycadet/ipc-contract";

const invokeItem =
  (ipc: IpcRenderer) =>
  (
    channel: string,
    kind: SystemPermissionKind,
  ): Promise<SystemPermissionStateItem> =>
    Promise.resolve(ipc.invoke(channel, kind));

export const install = (
  bridge: BridgeCapabilityRegistry<CadetBridge>,
  ipc: IpcRenderer,
): void => {
  bridge.contribute("permissions", {
    getState: (): Promise<SystemPermissionsState> =>
      Promise.resolve(ipc.invoke(PERMISSIONS_GET_STATE)),
    request: (kind) => invokeItem(ipc)(PERMISSIONS_REQUEST, kind),
    openSettings: (kind) => invokeItem(ipc)(PERMISSIONS_OPEN_SETTINGS, kind),
    quitAndReopen: (): Promise<void> =>
      Promise.resolve(ipc.invoke(PERMISSIONS_QUIT_AND_REOPEN)),
    onState: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        state: SystemPermissionsState,
      ) => callback(state);
      ipc.on(PERMISSIONS_STATE_EVENT, handler);
      return () => ipc.off(PERMISSIONS_STATE_EVENT, handler);
    },
  });
  bridge.contribute("text", {
    insertIntoFrontApp: (text): Promise<TextInsertionResult> =>
      Promise.resolve(ipc.invoke(TEXT_INSERT, text)),
    openAutomationSettings: (): Promise<void> =>
      Promise.resolve(ipc.invoke(TEXT_OPEN_SETTINGS)),
  });
};
