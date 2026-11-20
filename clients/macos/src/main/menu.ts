import { Menu, type MenuItemConstructorOptions, app } from "electron";

import { companionVisibilityItem } from "@mycadet/electron-desktop";
import { onSettingChange } from "@mycadet/electron-desktop/settings";
import {
  onCompanionHiddenChange,
  readCompanionHidden,
  readOnboardingActive,
} from "@mycadet/electron-desktop/window-state";

import { openAboutWindow } from "@mycadet/electron-desktop/about";
import { checkForUpdates } from "@mycadet/electron-desktop/auto-update";
import {
  isCliPathFlowInFlight,
  runInstallCliCommandFlow,
  runUninstallCliCommandFlow,
} from "./cli-path-flow";
import {
  type CliPathInstallState,
  getCliPathInstallState,
} from "./cli-path-installer";
import {
  acceleratorOption,
  dispatchToFocused,
  type CadetCommand,
} from "@mycadet/electron-desktop/commands";
import {
  closeCommandPaletteWindow,
  isCommandPaletteWindowFocused,
  openCommandPaletteWindow,
} from "@mycadet/electron-desktop/command-palette-window";
import { setCompanionSurfaceVisible } from "./companion-window";
import {
  editMenu,
  fileMenu,
  helpMenu,
  viewMenu,
  windowMenu,
} from "@mycadet/electron-desktop";
import { dispatchToMain } from "./main-window";

interface MenuState {
  hasCloudSession: boolean;
}

const state: MenuState = {
  hasCloudSession: false,
};

// Null until the first detection completes; the menu shows the Install item
// in the meantime (the install flow is safe to run from any state).
let cliPathState: CliPathInstallState | null = null;

export const refreshCliPathMenuState = async (): Promise<void> => {
  if (app.isPackaged) {
    try {
      cliPathState = await getCliPathInstallState();
    } catch {
      cliPathState = null;
    }
  }
  applyMenu();
};

const cliPathFlowItem = (
  label: string,
  flow: () => Promise<void>,
): MenuItemConstructorOptions => ({
  label,
  enabled: !isCliPathFlowInFlight(),
  click: async () => {
    const flowDone = flow();
    // Re-render immediately so the item is disabled while the flow runs.
    applyMenu();
    await flowDone;
    await refreshCliPathMenuState();
  },
});

const cliPathItems = (): MenuItemConstructorOptions[] => {
  // Only packaged builds manage the shared ~/.local/bin/cadet wrapper.
  if (!app.isPackaged) return [];
  const cliState = cliPathState;
  if (cliState?.kind === "installed" || cliState?.kind === "shadowed") {
    return [
      ...(cliState.kind === "shadowed"
        ? [
            {
              label: "⚠ cadet is shadowed by another install",
              enabled: false,
            },
          ]
        : []),
      // Wrapper exists but the CLI runtime never provisioned; the install
      // flow is idempotent, so re-running it doubles as repair.
      ...(!cliState.runtimeReady
        ? [
            cliPathFlowItem(
              "Repair cadet Command\u2026",
              runInstallCliCommandFlow,
            ),
          ]
        : []),
      cliPathFlowItem("Uninstall cadet Command", runUninstallCliCommandFlow),
    ];
  }
  return [
    cliPathFlowItem("Install cadet Command\u2026", runInstallCliCommandFlow),
  ];
};

export const dispatchMenuCommand = (command: CadetCommand): void => {
  if (command.kind === "commandPalette") {
    if (isCommandPaletteWindowFocused()) {
      closeCommandPaletteWindow();
      return;
    }
    openCommandPaletteWindow();
    return;
  }
  if (isCommandPaletteWindowFocused()) {
    dispatchToMain(command);
    return;
  }
  dispatchToFocused(command);
};

const buildTemplate = (): MenuItemConstructorOptions[] => {
  const isDev = !app.isPackaged;
  const cliItems = cliPathItems();

  return [
    {
      label: app.name,
      submenu: [
        {
          label: `About ${app.name}`,
          click: () => {
            openAboutWindow();
          },
        },
        ...(!isDev
          ? [
              {
                label: "Check for Updates\u2026",
                click: () => {
                  checkForUpdates();
                },
              },
            ]
          : []),
        { type: "separator" },
        {
          label: "Settings\u2026",
          ...acceleratorOption("openSettings"),
          enabled: !readOnboardingActive(),
          click: () => dispatchMenuCommand({ kind: "openSettings" }),
        },
        { type: "separator" },
        ...cliItems,
        ...(cliItems.length > 0 ? [{ type: "separator" as const }] : []),
        { role: "services" },
        { type: "separator" },
        state.hasCloudSession
          ? {
              label: "Log Out",
              click: () => dispatchMenuCommand({ kind: "logout" }),
            }
          : {
              label: "Log In",
              click: () => dispatchMenuCommand({ kind: "login" }),
            },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    // File/Edit/View/Window/Help are the shared groups; the macOS deltas
    // ride the palette-aware dispatch, the fullscreen chord, the zoom role,
    // and the companion/front rows.
    fileMenu({ dispatch: dispatchMenuCommand }),
    editMenu({ dispatch: dispatchMenuCommand }),
    viewMenu({
      dispatch: dispatchMenuCommand,
      fullscreenAccelerator: "Control+Command+F",
    }),
    windowMenu({
      dispatch: dispatchMenuCommand,
      zoomRole: true,
      tail: [
        // The show/hide checkbox the tray offers too, from the one builder
        // both read: two doors onto a single switch, not two switches.
        companionVisibilityItem(
          readCompanionHidden(),
          setCompanionSurfaceVisible,
        ),
        { type: "separator" },
        { role: "front" },
      ],
    }),
    helpMenu({ dispatch: dispatchMenuCommand, updatesRow: false }),
  ];
};

const applyMenu = (): void => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate()));
};

/**
 * The menu's Log In/Log Out toggle is this process's fact: the wiring
 * derives it from the session-token store and publishes here. See index.ts.
 */
export function setHasCloudSession(has: boolean): void {
  if (state.hasCloudSession === has) return;
  state.hasCloudSession = has;
  applyMenu();
}

/**
 * Builds and installs the macOS application menu. Without this, Electron
 * ships a default menu that includes developer-flavored items (Reload,
 * Toggle Developer Tools at the top level) and lacks the standard macOS
 * shape end users expect.
 *
 * The `View > Toggle Developer Tools` item is gated to dev/debug builds so a
 * normal packaged build doesn't expose devtools to end users.
 *
 * The menu's Log In/Log Out toggle is main's own fact — the wiring derives
 * it from the session-token store and publishes via setHasCloudSession —
 * so no renderer probe needs to publish session state.
 */
let installed = false;
export const installApplicationMenu = (): void => {
  if (installed) return;
  installed = true;

  // Rebuild the menu when hotkey settings change so accelerators update
  // immediately without requiring an app restart.
  onSettingChange("hotkeys", () => {
    applyMenu();
  });

  // Rebuild the menu when the companion surface is shown or hidden, so this
  // menu's checkbox agrees with the tray's. The tray builds its menu at pop
  // time and reads the flag fresh every time; this one is built once and kept,
  // so it is the surface that has to be told.
  onCompanionHiddenChange(() => {
    applyMenu();
  });

  applyMenu();

  // Detect the cadet CLI install state asynchronously so menu setup never
  // waits on (or breaks from) login-shell PATH resolution; packaged-only
  // gating lives inside refreshCliPathMenuState.
  void refreshCliPathMenuState();
};
