import { app } from "electron";

import { installAvatarIpc } from "@mycadet/electron-desktop/avatar";
import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@mycadet/electron-desktop/capability-registry";
import { installConnectivityProbe } from "@mycadet/electron-desktop/connectivity-probe";
import { installIdentityIpc } from "@mycadet/electron-desktop/identity";
import {
  configureLockfileWatcher,
  installLockfileWatcher,
} from "@mycadet/electron-desktop/lockfile-watcher";
import { installPowerEvents } from "@mycadet/electron-desktop/power-events";
import { configurePresenceRuntime } from "@mycadet/electron-desktop/presence-runtime";
import {
  installConnectivityIpc,
  installStatusIpc,
} from "@mycadet/electron-desktop/status";
import { resolveLockfilePaths } from "@mycadet/local-mode";

import { handle, on } from "../ipc.client";
import log from "../logger";
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
    configureLockfileWatcher(() => resolveLockfilePaths(process.env));
    const stopLockfileWatcher = installLockfileWatcher();
    app.once("before-quit", stopLockfileWatcher);
    installWindowsTray();
    installTaskbar({ getWindow: current });
  },
};

export default presence;
