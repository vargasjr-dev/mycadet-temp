import { ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  ConnectivityState,
  PowerEvent,
  CadetBridge,
} from "@mycadet/ipc-contract";
import {
  CONNECTIVITY_GET,
  CONNECTIVITY_RETRY,
  CONNECTIVITY_SET_DEVICE,
  CONNECTIVITY_STATE,
  DOCK_SET_BADGE,
  ICON_SET_AVATAR,
  ICON_SET_CHARACTER,
  IDENTITY_NAME,
  POWER_EVENT,
  STATUS_CONNECTION,
} from "@mycadet/ipc-contract";

export const install = (bridge: Partial<CadetBridge>): void => {
  bridge.status = {
    setConnection: (status) => ipcRenderer.send(STATUS_CONNECTION, status),
  };
  bridge.identity = {
    setName: (name) => ipcRenderer.send(IDENTITY_NAME, name),
  };
  bridge.icon = {
    setAvatar: (png) => ipcRenderer.send(ICON_SET_AVATAR, png),
    // `accentHex` is part of the character's contract (the avatar's accent
    // carried separately for the macOS dock icon) — forward it verbatim.
    setCharacter: (character, accentHex) =>
      ipcRenderer.send(ICON_SET_CHARACTER, character, accentHex ?? null),
  };
  bridge.dock = {
    setBadge: (count) => ipcRenderer.send(DOCK_SET_BADGE, count),
  };
  bridge.power = {
    onEvent: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: PowerEvent) => {
        callback(payload);
      };
      ipcRenderer.on(POWER_EVENT, handler);
      return () => ipcRenderer.off(POWER_EVENT, handler);
    },
  };
  bridge.connectivity = {
    onState: (callback) => {
      const handler = (_event: IpcRendererEvent, state: ConnectivityState) =>
        callback(state);
      ipcRenderer.on(CONNECTIVITY_STATE, handler);
      void Promise.resolve(ipcRenderer.invoke(CONNECTIVITY_GET)).then(callback);
      return () => ipcRenderer.off(CONNECTIVITY_STATE, handler);
    },
    get: (): Promise<ConnectivityState> =>
      Promise.resolve(ipcRenderer.invoke(CONNECTIVITY_GET)),
    setDevice: (online) => ipcRenderer.send(CONNECTIVITY_SET_DEVICE, online),
    retry: (): Promise<ConnectivityState> =>
      Promise.resolve(ipcRenderer.invoke(CONNECTIVITY_RETRY)),
  };
};
