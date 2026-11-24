import { app } from "electron";

import {
  hasPendingDeepLinks,
  hasPendingFiles,
  startApp,
} from "@mycadet/electron-desktop";

import { installDock } from "./dock";
import {
  promptToRelocateIfStranded,
  relocateToApplicationsFolder,
} from "./move-to-applications";
import { markRelocationSkipped } from "./install-location";

const isDev = !app.isPackaged;

// Dev-only: skip the real macOS Keychain for Chromium's `os_crypt` /
// Electron `safeStorage`.
if (isDev) {
  app.commandLine.appendSwitch("use-mock-keychain");
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

startApp({
  platform: "mac-electron",
  interfaceId: "macos",
  titleBarMode: "hidden",
  precheck: async () => {
    if (hasPendingFiles() || hasPendingDeepLinks()) {
      markRelocationSkipped();
      return false;
    }
    return relocateToApplicationsFolder();
  },
  setup() {
    installDock();
    void promptToRelocateIfStranded();
  },
});
