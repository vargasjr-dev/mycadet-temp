import { installDownloads } from "@mycadet/electron-desktop";

import { handle } from "@mycadet/electron-desktop/ipc";

/**
 * Windows downloads feature: the shared handler files renderer downloads into
 * the user's Downloads folder and reports each outcome to the originating
 * window, matching the macOS shell (minus the Dock bounce, which is a macOS
 * API). Distinct from `share.ts`, the "send elsewhere" intent served by a
 * Save As dialog.
 */
export const install = (): void => {
  installDownloads({ handle });
};
