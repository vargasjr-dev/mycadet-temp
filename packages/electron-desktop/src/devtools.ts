import { app } from "electron";

declare const __CADET_ENABLE_CHROME_DEVTOOLS__: boolean | undefined;

const isChromeDevToolsBuild = (): boolean =>
  typeof __CADET_ENABLE_CHROME_DEVTOOLS__ === "boolean" &&
  __CADET_ENABLE_CHROME_DEVTOOLS__;

export const areChromeDevToolsEnabled = (): boolean =>
  !app.isPackaged || isChromeDevToolsBuild();
