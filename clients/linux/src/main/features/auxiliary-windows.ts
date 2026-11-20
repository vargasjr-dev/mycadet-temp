import { app, screen } from "electron";

import {
  configureCommandPaletteWindow,
  installCommandPaletteWindow,
  repositionCommandPaletteWindow,
} from "@mycadet/electron-desktop/command-palette-window";
import {
  configureDictationOverlayWindow,
  installDictationOverlay,
  repositionDictationOverlayWindow,
  configureFloatingWindows,
  createWindowRouteResolver,
  configurePopoutWindows,
  installPopoutWindows,
  configureQuickInputWindow,
  installQuickInput,
  repositionQuickInputWindow,
  getRendererBase,
  restoreBounds,
  track as trackWindowState,
  log,
  createWindow,
} from "@mycadet/electron-desktop";
import { installEscapeMonitor, setDictationRecording } from "../escape-monitor";
import { handle, on } from "@mycadet/electron-desktop/ipc";
import { current, dispatchToMain, ensureVisible } from "../main-window";

const resolveRoute = createWindowRouteResolver(() =>
  getRendererBase(app.isPackaged),
);

export const install = (): void => {
  configureFloatingWindows({
    createWindow,
    platform: "linux",
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
    platform: "linux",
    resolveRoute,
  });
  // Native mouse-move forwarding for the click-through overlay is broken
  // on Windows (see `pollCursorForHover`); poll instead so the Stop button
  // can be hovered and clicked.
  configureDictationOverlayWindow({
    closeOnHide: true,
    pollCursorForHover: true,
    log: (message) => log.info(message),
    handle,
    on,
  });
  configurePopoutWindows({
    createWindow,
    handle,
    resolveRoute,
    restoreBounds,
    trackWindowState,
  });

  installEscapeMonitor();
  installCommandPaletteWindow();
  installQuickInput();
  installDictationOverlay({ onRecordingLifecycle: setDictationRecording });
  installPopoutWindows();

  const repositionTransientWindows = (): void => {
    repositionCommandPaletteWindow();
    repositionQuickInputWindow();
    repositionDictationOverlayWindow();
  };
  screen.on("display-added", repositionTransientWindows);
  screen.on("display-removed", repositionTransientWindows);
  screen.on("display-metrics-changed", repositionTransientWindows);
};
