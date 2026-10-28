import { app } from "electron";

import {
  configureAboutRuntime,
  getVersionInfo,
  installAbout as installSharedAbout,
  openAboutWindow,
} from "@mycadet/electron-desktop/about";
import { getName, onNameChange } from "@mycadet/electron-desktop/identity";

import { RENDERER_BASE_PROD } from "./app-config";
import { handle } from "./ipc";

configureAboutRuntime({
  rendererBase: () => RENDERER_BASE_PROD,
  getAssistantName: getName,
  onAssistantNameChange: onNameChange,
});

export { getVersionInfo, openAboutWindow, webBundleVersion } from "@mycadet/electron-desktop/about";

export const installAbout = (): void => {
  installSharedAbout({ handle });
};
