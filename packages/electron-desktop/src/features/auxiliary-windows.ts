import { app, screen } from "electron";

import {
  configureCommandPaletteWindow,
  installCommandPaletteWindow,
  repositionCommandPaletteWindow,
} from "../command-palette-window";
import {
  configureFloatingWindows,
  createWindowRouteResolver,
} from "../floating-window";
import { configurePopoutWindows, installPopoutWindows } from "../popout-window";
import {
  configureQuickInputWindow,
  installQuickInput,
  repositionQuickInputWindow,
} from "../quick-input-window";
import {
  configureDictationOverlayWindow,
  installDictationOverlay,
  repositionDictationOverlayWindow,
} from "../dictation-overlay-window";
import { getRendererBase } from "../app-config";
import { restoreBounds, track as trackWindowState } from "../window-state";
import { createWindow } from "../windows";
import log from "../app-logger";
import { installEscapeMonitor, setDictationRecording } from "../escape-monitor";
import { handle, on } from "../ipc";
import { current, dispatchToMain, ensureVisible } from "../main-window";

const resolveRoute = createWindowRouteResolver(() =>
  getRendererBase(app.isPackaged),
);

export const install = (): void => {
  configureFloatingWindows({
    createWindow,
    platform: process.platform === "win32" ? "win32" : "linux",
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
    platform: process.platform === "win32" ? "win32" : "linux",
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
