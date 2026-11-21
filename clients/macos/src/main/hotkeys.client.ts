import { installHotkeysIpc as installSharedHotkeysIpc } from "@mycadet/electron-desktop";

export const installHotkeysIpc = (): void => {
  // Talk is the voice key's double tap on this shell, so the chord is not on
  // offer; `installGlobalShortcuts` passes no handler for it either.
  installSharedHotkeysIpc({ exclude: ["toggleVoice"] });
};
