import type { BrowserWindow } from "electron";
import {
  capabilityToken,
  type DesktopCapabilityRegistry,
  type MainWindowController,
} from "@mycadet/electron-desktop/capability-registry";

import { current, ensureVisible, installMainWindow } from "../main-window";

export const MAIN_WINDOW_CONTROLLER =
  capabilityToken<MainWindowController<BrowserWindow>>("main-window");

export const install = (registry: DesktopCapabilityRegistry): void => {
  installMainWindow();
  registry.provide(MAIN_WINDOW_CONTROLLER, { current, ensureVisible });
};
