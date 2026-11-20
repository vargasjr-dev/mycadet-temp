import {
  installGlobalShortcuts as installSharedGlobalShortcuts,
  toggleQuickInput,
} from "@mycadet/electron-desktop";

import "./commands.client";
import log from "@mycadet/electron-desktop/app-logger";
import { ensureVisible } from "./main-window";

export const installGlobalShortcuts = (): void => {
  installSharedGlobalShortcuts({
    handlers: {
      globalHotkey: () => {
        void ensureVisible();
      },
      quickInput: toggleQuickInput,
      // No Talk chord: the voice key's double tap is the keyboard way into a
      // call on this shell, and it needs no global registration.
    },
    logger: log,
  });
};
