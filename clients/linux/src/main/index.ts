import { startApp } from "@mycadet/electron-desktop";

startApp({
  platform: "linux-electron",
  titleBarMode: "systemFrame",
  helperToastExecutable: "cadet-linux-helper",
  helperToastOverrideEnvVar: "CADET_LINUX_HELPER_PATH",
  helperToastName: "linux-helper",
});
