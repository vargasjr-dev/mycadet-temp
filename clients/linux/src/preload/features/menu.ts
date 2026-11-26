import { ipcRenderer } from "electron";

import type { BridgeCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import {
  MENU_POPUP,
  MENU_TITLES,
  type CadetBridge,
} from "@mycadet/ipc-contract";

/**
 * The menu-bar surface this platform's main process serves (macOS
 * registers no menu IPC, so its preload never exposes this).
 */
export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  registry.contribute("menu", {
    titles: (): Promise<Array<{ id: string; label: string }>> =>
      Promise.resolve(ipcRenderer.invoke(MENU_TITLES)),
    popup: (id, x, y): Promise<void> =>
      Promise.resolve(ipcRenderer.invoke(MENU_POPUP, id, x, y)),
  });
};
