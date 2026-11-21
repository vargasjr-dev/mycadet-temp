import { app } from "electron";

import {
  APP_HOST,
  APP_PROTOCOL,
  getDeviceId,
  getVersionInfo,
  startApp,
} from "@mycadet/electron-desktop";
import { handleSync } from "@mycadet/electron-desktop/ipc";

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
// under. startApp resolves the binary and builds the factory; absent a
// helper binary, the shared default electron.Notification path delivers
// click-only toasts. Everything else in the lifecycle — the lock, the
// schemes, the launch capture, the universal surface, the CLI provisioning
// (the launcher flow on this platform), the second-instance focus — is
// startApp's.
startApp({
  helperToast: {
    executable: "Cadet.WindowsHelper.exe",
    overrideEnvVar: "CADET_WINDOWS_HELPER_PATH",
    name: "windows-helper",
  },
});
