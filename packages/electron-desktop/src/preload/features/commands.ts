import type { IpcRenderer } from "electron";

import type { BridgeCapabilityRegistry } from "../../capability-registry";
import { createHotkeysBridge } from "../../preload";
import {
  MENU_POPUP,
  MENU_TITLES,
  type CadetBridge,
} from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
  ipc: IpcRenderer,
): void => {
  registry.contribute("hotkeys", createHotkeysBridge(ipc));
  registry.contribute("menu", {
    titles: () =>
      ipc.invoke(MENU_TITLES) as Promise<Array<{ id: string; label: string }>>,
    popup: (id, x, y) => ipc.invoke(MENU_POPUP, id, x, y) as Promise<void>,
  });
};
