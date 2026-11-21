import { configureCommandPaletteWindow } from "@mycadet/electron-desktop/command-palette-window";
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
});
configureQuickInputWindow({
  createWindow,
  dispatchToMain,
  ensureMainWindowVisible: ensureVisible,
  platform: "darwin",
  resolveRoute,
});
configurePopoutWindows({
  createWindow,
  resolveRoute,
  restoreBounds,
  trackWindowState,
});
