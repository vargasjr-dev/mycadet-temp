import "./env-seed";

import { app } from "electron";

import {
  APP_HOST,
  APP_PROTOCOL,
  createHelperToastFactory,
  ensureVisible,
  getDeviceId,
  getVersionInfo,
  log,
  provisionCliForCurrentUser,
  resolveCliPathFlowOptions,
  resolveHelperToastBinaryPath,
  startApp,
} from "@mycadet/electron-desktop";
import { handleSync } from "@mycadet/electron-desktop/ipc";
import { installClassicShellFeatures } from "@mycadet/electron-desktop/classic-shell";

// Toasts and taskbar grouping key off the AppUserModelID, which must match
// the installed shortcut's id — the builder config is the single source, so
// the build define is read here rather than round-tripped through a
// release-info module. macOS/Linux need no such call: their identity rides
// the OS bundle metadata (Info.plist / the .desktop file).
declare const __CADET_APP_USER_MODEL_ID__: string;
app.setAppUserModelId(
  typeof __CADET_APP_USER_MODEL_ID__ === "string"
    ? __CADET_APP_USER_MODEL_ID__
    : "ai.mycadet.electron",
);

handleSync("cadet:config:get", () => ({
  baseUrl: `${APP_PROTOCOL}://${APP_HOST}`,
  deviceId: getDeviceId(),
  version: getVersionInfo().version,
}));

// This shell's toast-helper identity: the supervised sidecar's executable
// name, its dev-override env var, and the sidecar client name it registers
// under. Absent a helper binary, startApp's default electron.Notification
// path delivers click-only toasts.
const helperPath = resolveHelperToastBinaryPath({
  executable: "Cadet.WindowsHelper.exe",
  overrideEnvVar: "CADET_WINDOWS_HELPER_PATH",
});

startApp(
  log,
  () => {
    // Every main-process feature, in the glob-sorted order the old
    // auto-discovery hid — one ordered list in the package now, since both
    // classic-desktop shells ran it identically. The universal installs
    // (protocol stack, identity slice, launch capture, notification
    // runtime, web-contents security) ran earlier, in startApp.
    installClassicShellFeatures();
  },
  {
    ensureVisible,
    ...(helperPath
      ? {
          notifications: {
            create: createHelperToastFactory({
              helperPath,
              name: "windows-helper",
            }),
          },
        }
      : {}),
    provisionCli: () => {
      if (!app.isPackaged) {
        return;
      }
      try {
        const result = provisionCliForCurrentUser(resolveCliPathFlowOptions());
        if (["foreign", "shadowed"].includes(result.launcherState)) {
          log.warn(`[cli] Windows launcher is ${result.launcherState}`);
        }
      } catch (error) {
        log.error("[cli] Failed to provision the Windows CLI:", error);
      }
    },
  },
);

app.on("second-instance", () => {
  ensureVisible();
});
