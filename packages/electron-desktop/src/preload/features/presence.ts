import { type IpcRenderer, type IpcRendererEvent } from "electron";

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
import type { BridgeCapabilityRegistry } from "../../capability-registry";

export const install = (
  bridge: BridgeCapabilityRegistry<CadetBridge>,
  ipc: IpcRenderer,
): void => {
  bridge.contribute("status", {
    setConnection: (status) => ipc.send(STATUS_CONNECTION, status),
  });
  bridge.contribute("identity", {
    setName: (name) => ipc.send(IDENTITY_NAME, name),
  });
  bridge.contribute("icon", {
    setAvatar: (png) => ipc.send(ICON_SET_AVATAR, png),
    setCharacter: (character) => ipc.send(ICON_SET_CHARACTER, character),
  });
  bridge.contribute("dock", {
    setBadge: (count) => ipc.send(DOCK_SET_BADGE, count),
  });
  bridge.contribute("power", {
    onEvent: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: PowerEvent) => {
        callback(payload);
      };
      ipc.on(POWER_EVENT, handler);
      return () => ipc.off(POWER_EVENT, handler);
    },
  });
  bridge.contribute("connectivity", {
    onState: (callback) => {
      const handler = (_event: IpcRendererEvent, state: ConnectivityState) =>
        callback(state);
      ipc.on(CONNECTIVITY_STATE, handler);
      void Promise.resolve(ipc.invoke(CONNECTIVITY_GET)).then(callback);
      return () => ipc.off(CONNECTIVITY_STATE, handler);
    },
    get: (): Promise<ConnectivityState> =>
      Promise.resolve(ipc.invoke(CONNECTIVITY_GET)),
    setDevice: (online) => ipc.send(CONNECTIVITY_SET_DEVICE, online),
    retry: (): Promise<ConnectivityState> =>
      Promise.resolve(ipc.invoke(CONNECTIVITY_RETRY)),
  });
};
