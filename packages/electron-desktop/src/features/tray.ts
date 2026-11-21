import { current } from "../main-window";
import { installTaskbar } from "../taskbar";
import { installTrayRuntime } from "../tray-runtime";

export const install = (): void => {
  installTrayRuntime();
  if (process.platform === "win32") {
    // The Windows taskbar rides the main window: the unread-conversations
    // overlay badge, the assistant status as progress. The tray item set
    // above is the same on both classic-desktop shells.
    installTaskbar({ getWindow: current });
  }
};
