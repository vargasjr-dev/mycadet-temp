/**
 * History navigation for the desktop menu bar, shared by all three
 * clients' View menus. Electron ships no menu roles for back/forward, so
 * the items step the focused window's `navigationHistory` directly: the
 * shell is a SPA, whose pushState entries ride the same history as any
 * load, so a step back or forward lands on the previous in-app surface.
 * Reload stays a role — the focused window is what reloads.
 */
import { BrowserWindow, type MenuItemConstructorOptions } from "electron";

/** Step the focused window's history; no-op when nothing is focused. */
export const navigateFocused = (direction: "back" | "forward"): void => {
  const history = BrowserWindow.getFocusedWindow()?.webContents
    .navigationHistory;
  if (!history) {
    return;
  }
  if (direction === "back") {
    history.goBack();
  } else {
    history.goForward();
  }
};

/** The View menu's history rows, spread into the platform's submenu. */
export const historyNavigationMenuItems = (): MenuItemConstructorOptions[] => [
  {
    label: "Back",
    accelerator: "CmdOrCtrl+[",
    click: () => navigateFocused("back"),
  },
  {
    label: "Forward",
    accelerator: "CmdOrCtrl+]",
    click: () => navigateFocused("forward"),
  },
];
