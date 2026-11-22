import { app } from "electron";

import { startApp } from "@mycadet/electron-desktop";

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

startApp({
  platform: "win-electron",
  interfaceId: "windows",
  titleBarMode: "hiddenOverlay",
  helperToastExecutable: "Cadet.WindowsHelper.exe",
  helperToastOverrideEnvVar: "CADET_WINDOWS_HELPER_PATH",
  helperToastName: "windows-helper",
});
