import { app } from "electron";

import { configureAboutRuntime, installAbout } from "../about";
import { installGlobalShortcuts } from "../global-shortcuts";
import { installHotkeysIpc } from "../hotkeys";
import { getName, onNameChange } from "../identity";
import { installImageContextMenu } from "../image-context-menu";
import { installTextContextMenu } from "../text-context-menu";
import { toggleQuickInput } from "../quick-input-window";
import { getRendererBase } from "../app-config";
import log from "../app-logger";
import { current, dispatchToMain, ensureVisible } from "../main-window";
import { installDesktopMenu } from "../menu";

/**
 * The classic-desktop shells' command surface: the hotkey catalog IPC, the
 * About runtime, global shortcuts, the application menu, and the context
 * menus every webContents gets. All of it rides the shared package wiring —
 * the menu reads its own session, onboarding, companion, and CLI state.
 */
export const install = (): void => {
  // Hotkey settings ride the shared settings-store provider startApp
  // configures; the IPC surface is unconditional for the same reason.
  installHotkeysIpc();

  configureAboutRuntime({
    rendererBase: () => getRendererBase(app.isPackaged),
    getAssistantName: getName,
    onAssistantNameChange: onNameChange,
  });
  installAbout();

  installGlobalShortcuts({
    handlers: {
      globalHotkey: () => {
        void ensureVisible();
      },
      // Registered through installGlobalShortcuts so the Keyboard
      // Shortcuts rebinding applies and the chord is bound exactly once.
      quickInput: toggleQuickInput,
      // Talk, from wherever the user is. `registerAll` skips a command with
      // no handler, so without this the binding would be offered in both
      // Keyboard Shortcuts and Voice settings, show as bound, and do
      // nothing. Never raises the window: the point of a global binding is
      // that the user is working somewhere else.
      toggleVoice: () => {
        if (current() !== null) {
          dispatchToMain({ kind: "toggleVoice" });
          return;
        }
        // No renderer to act in. Building one necessarily shows it, which
        // is still better than a press that lands nowhere.
        void ensureVisible().then(() => {
          dispatchToMain({ kind: "toggleVoice" });
        });
      },
    },
    logger: log,
  });
  installDesktopMenu();

  app.on("web-contents-created", (_event, contents) => {
    installImageContextMenu(contents);
    installTextContextMenu(contents);
  });
};
