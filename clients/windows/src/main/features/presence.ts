import { app } from "electron";

import { installAvatarIpc } from "@mycadet/electron-desktop/avatar";
import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@mycadet/electron-desktop/capability-registry";
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

import { handle, on } from "../ipc.client";
import { log } from "@mycadet/electron-desktop";
import { current } from "../main-window";
import { installTaskbar } from "../taskbar";
import { installWindowsTray } from "../tray";

const presence: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "presence",
  install: () => {
    configurePresenceRuntime({ ipc: { handle, on }, logger: log });
    installAvatarIpc();
    installIdentityIpc();
    installPowerEvents();
    installStatusIpc();
    const retryProbe = installConnectivityProbe();
    installConnectivityIpc(retryProbe);
    installWindowsTray();
    installTaskbar({ getWindow: current });
  },
};

export default presence;
