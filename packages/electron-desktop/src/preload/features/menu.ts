import { ipcRenderer } from "electron";

import type { CadetBridge } from "@mycadet/ipc-contract";
import { MENU_POPUP, MENU_TITLES } from "@mycadet/ipc-contract";

/**
 * The menu-bar surface: the renderer draws the top-level titles in its
 * frameless title bar and pops the real native submenus through the main
 * process, whose shared `installDesktopMenu` owns the one template —
 * macOS's app menu included.
 */
export const menuBridge: CadetBridge["menu"] = {
  titles: (): Promise<Array<{ id: string; label: string }>> =>
    ipcRenderer.invoke(MENU_TITLES),
  popup: (id, x, y): Promise<void> => ipcRenderer.invoke(MENU_POPUP, id, x, y),
};
