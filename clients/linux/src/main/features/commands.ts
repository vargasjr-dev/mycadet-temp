import { app } from "electron";

import {
  configureAboutRuntime,
  installAbout,
  openAboutWindow,
} from "@mycadet/electron-desktop/about";
import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@mycadet/electron-desktop/capability-registry";
import {
  configureHotkeySettings,
  HOTKEY_SETTINGS,
} from "@mycadet/electron-desktop/commands";
import { installGlobalShortcuts } from "@mycadet/electron-desktop/global-shortcuts";
import { installHotkeysIpc } from "@mycadet/electron-desktop/hotkeys";
import { getName, onNameChange } from "@mycadet/electron-desktop/identity";
import { installImageContextMenu } from "@mycadet/electron-desktop/image-context-menu";
import { toggleQuickInput } from "@mycadet/electron-desktop/quick-input-window";
import {
  getSessionToken,
  onSessionTokenChange,
} from "@mycadet/electron-desktop/session-token-store";
import { installTextContextMenu } from "@mycadet/electron-desktop/text-context-menu";

import { getRendererBase } from "../app-config";
import { checkForUpdates } from "../auto-update";
import { runInstallCliCommandFlow } from "../cli-path-flow";
import { handle } from "../ipc.client";
import log from "../logger";
import { current, dispatchToMain, ensureVisible } from "../main-window";
import { installLinuxMenu, setLinuxHasCloudSession } from "../menu";

const commandsFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "commands",
  install: (capabilities) => {
    const hotkeySettings = capabilities.get(HOTKEY_SETTINGS);
    configureHotkeySettings(hotkeySettings);
    if (hotkeySettings) {
      installHotkeysIpc({ handle });
    }

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
    installLinuxMenu({
      handle,
      openAbout: openAboutWindow,
      checkForUpdates,
      installCli: () => {
        void runInstallCliCommandFlow();
      },
    });
    // The menu's Log In/Log Out toggle is main's fact: derived from the same
    // token store the OAuth flow and sign-out write.
    setLinuxHasCloudSession(!!getSessionToken());
    onSessionTokenChange(() => {
      setLinuxHasCloudSession(!!getSessionToken());
    });

    app.on("web-contents-created", (_event, contents) => {
      installImageContextMenu(contents);
      installTextContextMenu(contents);
    });
  },
};

export default commandsFeature;
