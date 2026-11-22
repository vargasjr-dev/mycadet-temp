import { screen } from "electron";

import { repositionCommandPaletteWindow } from "../command-palette-window";
import {
  installDictationOverlay,
  repositionDictationOverlayWindow,
} from "../dictation-overlay-window";
import { repositionQuickInputWindow } from "../quick-input-window";

/**
 * Install the classic shells' auxiliary-window surfaces: the dictation
 * overlay with its escape monitor, plus the display-change repositioning
 * for every transient panel. The window modules read their wiring from
 * their own imports — there is nothing left to configure here.
 */
export const install = (): void => {
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
