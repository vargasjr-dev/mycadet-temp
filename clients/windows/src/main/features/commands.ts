import { app } from "electron";

import {
  configureAboutRuntime,
  installAbout,
  openAboutWindow,
} from "@mycadet/electron-desktop/about";
import {
  installGlobalShortcuts,
  installHotkeysIpc,
  getName,
  onNameChange,
  installImageContextMenu,
} from "@mycadet/electron-desktop";
import {
  getSessionToken,
  onSessionTokenChange,
} from "@mycadet/electron-desktop/session-token-store";
import {
  toggleQuickInput,
  installTextContextMenu,
} from "@mycadet/electron-desktop";

import { getRendererBase } from "@mycadet/electron-desktop";
import { checkForUpdates } from "@mycadet/electron-desktop/auto-update";
import { runInstallCliCommandFlow } from "../cli-path-flow";
import { handle } from "@mycadet/electron-desktop/ipc";
import { log } from "@mycadet/electron-desktop";
import {
  current,
  dispatchToMain,
  ensureVisible,
  onOnboardingChange,
} from "../main-window";
import {
  installDesktopMenu,
  setDesktopHasCloudSession,
} from "@mycadet/electron-desktop";

export const install = (): void => {
  // Hotkey settings ride the shared settings-store provider startApp
  // configures; the IPC surface is unconditional for the same reason.
  installHotkeysIpc({ handle });

  configureAboutRuntime({
    rendererBase: () => getRendererBase(app.isPackaged),
    getAssistantName: getName,
    onAssistantNameChange: onNameChange,
  });
  installAbout({ handle });

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
  installDesktopMenu({
    handle,
    openAbout: openAboutWindow,
    checkForUpdates,
    installCli: () => {
      void runInstallCliCommandFlow();
    },
    onOnboardingChange,
  });
  // The menu's Log In/Log Out toggle is main's fact: derived from the same
  // token store the OAuth flow and sign-out write.
  setDesktopHasCloudSession(!!getSessionToken());
  onSessionTokenChange(() => {
    setDesktopHasCloudSession(!!getSessionToken());
  });

  app.on("web-contents-created", (_event, contents) => {
    installImageContextMenu(contents);
    installTextContextMenu(contents);
  });
};
