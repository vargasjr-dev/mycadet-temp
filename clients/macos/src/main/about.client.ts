import {
  configureAboutRuntime,
  installAbout as installSharedAbout,
} from "@mycadet/electron-desktop/about";
import { getName, onNameChange } from "@mycadet/electron-desktop";

import { APP_RENDERER_BASE_PROD } from "@mycadet/electron-desktop";
import { handle } from "@mycadet/electron-desktop/ipc";

configureAboutRuntime({
  // The About window renders the app bundle's root-based /about route,
  // not the web bundle's /assistant mount.
  rendererBase: () => APP_RENDERER_BASE_PROD,
  getAssistantName: getName,
  onAssistantNameChange: onNameChange,
});

export const installAbout = (): void => {
  installSharedAbout({ handle });
};
