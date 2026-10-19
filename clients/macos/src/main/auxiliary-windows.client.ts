import { app } from "electron";

import { configureCommandPaletteWindow } from "@mycadet/electron-desktop/command-palette-window";
import { configureDictationOverlayWindow } from "@mycadet/electron-desktop/dictation-overlay-window";
import {
  configureFloatingWindows,
  createWindowRouteResolver,
} from "@mycadet/electron-desktop/floating-window";
import { configurePopoutWindows } from "@mycadet/electron-desktop/popout-window";
import { configureQuickInputWindow } from "@mycadet/electron-desktop/quick-input-window";
import {
  restoreBounds,
  track as trackWindowState,
} from "@mycadet/electron-desktop/window-state";

import { RENDERER_BASE_PROD } from "./app-config";
import { handle, on } from "./ipc";
import { current, dispatchToMain, ensureVisible } from "./main-window";
import { createWindow } from "./windows";

const resolveRoute = createWindowRouteResolver(() => RENDERER_BASE_PROD);

configureFloatingWindows({
  createWindow,
  platform: "darwin",
  resolveRoute,
});
configureCommandPaletteWindow({
  currentMainWindow: current,
  dispatchToMain,
  ensureMainWindowVisible: ensureVisible,
  handle,
});
configureQuickInputWindow({
  createWindow,
  dispatchToMain,
  ensureMainWindowVisible: ensureVisible,
  handle,
  platform: "darwin",
  resolveRoute,
});
configureDictationOverlayWindow({ handle, on });
configurePopoutWindows({
  createWindow,
  handle,
  resolveRoute,
  restoreBounds,
  trackWindowState,
});
