import { configureCommandPaletteWindow } from "@mycadet/electron-desktop/command-palette-window";
import { configureDictationOverlayWindow } from "@mycadet/electron-desktop";
import {
  configureFloatingWindows,
  createWindowRouteResolver,
} from "@mycadet/electron-desktop/floating-window";
import {
  configurePopoutWindows,
  configureQuickInputWindow,
} from "@mycadet/electron-desktop";
import {
  restoreBounds,
  track as trackWindowState,
} from "@mycadet/electron-desktop/window-state";

import { RENDERER_BASE_PROD } from "@mycadet/electron-desktop";
import { handle, on } from "@mycadet/electron-desktop/ipc";
import { current, dispatchToMain, ensureVisible } from "./main-window";
import { createWindow } from "@mycadet/electron-desktop";

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
