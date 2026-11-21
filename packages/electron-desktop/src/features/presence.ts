import { installAvatarIpc } from "../avatar";
import { configurePresenceRuntime } from "../presence-runtime";
import { installPowerEvents } from "../power-events";
import { installConnectivityProbe } from "../connectivity-probe";
import { installIdentityIpc } from "../identity";
import { installConnectivityIpc, installStatusIpc } from "../status";

import { handle, on } from "../ipc";
import log from "../app-logger";
import { current } from "../main-window";
import { installTaskbar } from "../taskbar";
import { installTrayRuntime } from "../tray-runtime";

export const install = (): void => {
  configurePresenceRuntime({ ipc: { handle, on }, logger: log });
  installAvatarIpc();
  installIdentityIpc();
  installPowerEvents();
  installStatusIpc();
  const retryProbe = installConnectivityProbe();
  installConnectivityIpc(retryProbe);
  installTrayRuntime();
  if (process.platform === "win32") {
    // The Windows taskbar rides the main window: the unread-conversations
    // overlay badge, the assistant status as progress. The tray item set
    // above is the same on both classic-desktop shells.
    installTaskbar({ getWindow: current });
  }
};
