import { openAboutWindow } from "../about";
import { current, ensureVisible, toggleVisibility } from "../main-window";
import { installTaskbar } from "../taskbar";
import { installTrayRuntime } from "../tray-runtime";
import { configureTrayModel, installTray } from "../tray-model";
import type { TrayModelRuntime } from "../tray-model";

/**
 * The tray installs on every desktop: the shell either passes its own
 * model values (the surfaces only it has — icons, companion callbacks) or
 * the shared composition answers with the classic notification-area
 * runtime. `taskbar` is the shell opting into the taskbar-button surface
 * (the unread-conversations overlay badge, the assistant status as
 * progress).
 */
export const install = (
  tray?: { runtime: TrayModelRuntime },
  taskbar?: boolean,
): void => {
  if (tray) {
    configureTrayModel(tray.runtime);
    installTray({
      ensureMainWindow: async () => ensureVisible(),
      openAbout: openAboutWindow,
      toggleMainWindow: toggleVisibility,
    });
  } else {
    installTrayRuntime();
  }
  if (taskbar) {
    installTaskbar({ getWindow: current });
  }
};
