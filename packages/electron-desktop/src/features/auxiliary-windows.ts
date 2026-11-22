import { screen } from "electron";

import {
  configureCommandPaletteWindow,
  repositionCommandPaletteWindow,
} from "../command-palette-window";
import {
  configureFloatingWindows,
  createWindowRouteResolver,
} from "../floating-window";
import { configurePopoutWindows } from "../popout-window";
import {
  configureQuickInputWindow,
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
import { current, dispatchToMain, ensureVisible } from "../main-window";

const resolveRoute = createWindowRouteResolver(() => getRendererBase());

/**
 * Configure and install the classic shells' auxiliary-window surfaces: the
 * floating-window wiring and the dictation overlay with its escape monitor.
 * The installs for the command palette, quick input, and popouts are
 * `startApp`'s — shared with the macOS shell, which configures the same
 * modules with its own window accessors.
 */
export const install = (): void => {
  configureFloatingWindows({
    createWindow,
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
    resolveRoute,
  });
  // Native mouse-move forwarding for the click-through overlay is broken
  // on Windows (see `pollCursorForHover`); poll instead so the Stop button
  // can be hovered and clicked.
  configureDictationOverlayWindow({
    closeOnHide: true,
    pollCursorForHover: true,
    log: (message) => log.info(message),
  });
  configurePopoutWindows({
    createWindow,
    resolveRoute,
    restoreBounds,
    trackWindowState,
  });

  installDictationOverlay();

  const repositionTransientWindows = (): void => {
    repositionCommandPaletteWindow();
    repositionQuickInputWindow();
    repositionDictationOverlayWindow();
  };
  screen.on("display-added", repositionTransientWindows);
  screen.on("display-removed", repositionTransientWindows);
  screen.on("display-metrics-changed", repositionTransientWindows);
};
