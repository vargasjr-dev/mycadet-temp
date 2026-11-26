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
    titles: (): Promise<Array<{ id: string; label: string }>> =>
      Promise.resolve(ipc.invoke(MENU_TITLES)),
    popup: (id, x, y): Promise<void> =>
      Promise.resolve(ipc.invoke(MENU_POPUP, id, x, y)),
  });
};
