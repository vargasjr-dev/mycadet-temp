import { app } from "electron";

import { installAvatarIpc } from "@mycadet/electron-desktop/avatar";
import {
  installConnectivityProbe,
  installIdentityIpc,
  installPowerEvents,
  configurePresenceRuntime,
} from "@mycadet/electron-desktop";
import {
  installConnectivityIpc,
  installStatusIpc,
} from "@mycadet/electron-desktop/status";

import { handle, on } from "@mycadet/electron-desktop/ipc";
import { log } from "@mycadet/electron-desktop";
import { installLinuxTray } from "../tray";

export const install = (): void => {
  configurePresenceRuntime({ ipc: { handle, on }, logger: log });
  installAvatarIpc();
  installIdentityIpc();
  installPowerEvents();
  installStatusIpc();
  const retryProbe = installConnectivityProbe();
  installConnectivityIpc(retryProbe);
  installLinuxTray();
};
