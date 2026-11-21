/**
 * The desktop menu bar, shared by the three clients — one owner for the
 * whole template now: macOS gets the app menu (About, updates, Settings,
 * the CLI wrapper rows, session, roles) prepended and its fullscreen chord,
 * zoom role, and companion rows applied; Windows and Linux ship the
 * frameless template whose install also owns the popup IPC.
 */
import {
  BrowserWindow,
  Menu,
  app,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { z } from "zod";

import { MENU_POPUP, MENU_TITLES } from "@mycadet/ipc-contract";

import {
  acceleratorOption,
  dispatchToFocused,
  onHotkeyOverridesChange,
  type CadetCommand,
} from "./commands";
import { areChromeDevToolsEnabled } from "./devtools";
import { openAboutWindow } from "./about";
import { checkForUpdates } from "./auto-update";
import { handle } from "./ipc";
import { getSessionToken, onSessionTokenChange } from "./session-token-store";
import {
  onCompanionHiddenChange,
  onOnboardingChange,
  readCompanionHidden,
  readOnboardingActive,
} from "./window-state";
import {
  companionVisibilityItem,
  setCompanionSurfaceVisible,
} from "./companion-menu";
// The CLI rows ride this process's own platform family: the wrapper
// (macOS + Linux, a symlink in the user's bin dir) or the Windows launcher
// (a PATH entry written for the current user).
import {
  isCliPathFlowInFlight,
  runInstallCliCommandFlow as runWrapperCliInstallFlow,
  runUninstallCliCommandFlow,
} from "./cli-path-flow";
import { getCliPathInstallState } from "./cli-path-installer";
import { runInstallCliCommandFlow as runLauncherCliInstallFlow } from "./win32-cli/cli-path-flow";

/** Builds one command row: the accelerator flavor + the focused-window
 * dispatch (which owns the palette-aware routing). */
export type MenuCommandItem = (
  label: string,
  command: CadetCommand,
  enabled?: boolean,
) => MenuItemConstructorOptions;

/** The one row builder every menu group shares. */
const commandItem = (): MenuCommandItem => (label, command, enabled) => ({
  label,
  ...acceleratorOption(command.kind),
  ...(enabled === undefined ? {} : { enabled }),
  click: () => dispatchToFocused(command),
});

/** Step the focused window's history; no-op when nothing is focused. */
export const navigateFocused = (direction: "back" | "forward"): void => {
  const history =
    BrowserWindow.getFocusedWindow()?.webContents.navigationHistory;
  if (!history) {
    return;
  }
  if (direction === "back") {
    history.goBack();
  } else {
    history.goForward();
  }
};

/** The View menu's history rows, spread into the platform's submenu. */
export const historyNavigationMenuItems = (): MenuItemConstructorOptions[] => [
  {
    label: "Back",
    accelerator: "CmdOrCtrl+[",
    click: () => navigateFocused("back"),
  },
  {
    label: "Forward",
    accelerator: "CmdOrCtrl+]",
    click: () => navigateFocused("forward"),
  },
];

const separator = (): MenuItemConstructorOptions => ({ type: "separator" });

/** The File menu's conversation rows — the head both platforms share. */
export const conversationFileMenuItems = (
  item: MenuCommandItem,
): MenuItemConstructorOptions[] => [
  item("New Conversation", { kind: "newConversation" }),
  item("Current Conversation", { kind: "currentConversation" }),
  separator(),
  item("Pin Current Conversation", { kind: "togglePinConversation" }),
  item("Mark Current as Unread", { kind: "markCurrentUnread" }),
  item("Previous Conversation", { kind: "previousConversation" }),
  item("Next Conversation", { kind: "nextConversation" }),
  separator(),
];

/** The Edit menu — identical on every platform (macOS passes its roles). */
export const editMenuItems = (
  item: MenuCommandItem,
): MenuItemConstructorOptions[] => [
  { role: "undo" },
  { role: "redo" },
  separator(),
  { role: "cut" },
  { role: "copy" },
  { role: "paste" },
  { role: "selectAll" },
  separator(),
  item("Find...", { kind: "find" }),
];

/** The View menu — identical on every platform bar the fullscreen chord. */
export const viewMenuItems = (
  item: MenuCommandItem,
): MenuItemConstructorOptions[] => [
  item("Toggle Sidebar", { kind: "sidebarToggle" }),
  item("Command Palette...", { kind: "commandPalette" }),
  separator(),
  ...historyNavigationMenuItems(),
  separator(),
  { role: "reload" },
  { role: "forceReload" },
  ...(areChromeDevToolsEnabled() ? [{ role: "toggleDevTools" as const }] : []),
  separator(),
  { role: "resetZoom" },
  { role: "zoomIn" },
  { role: "zoomOut" },
  separator(),
  { role: "togglefullscreen" },
];

/** The Windows/Linux install row: a direct click, not a command dispatch. */
const installCliRow = (installCli: (() => void) | undefined) => ({
  label: "Install cadet Command...",
  enabled: installCli !== undefined,
  click: installCli,
});

/**
 * The menu-facing shape of the cadet CLI wrapper's install state — what the
 * clients' cli-path installers detect and the macOS app menu renders as
 * Install/Repair/Uninstall rows.
 */
export type CliPathMenuState =
  | { kind: "not-installed" }
  | { kind: "foreign-file" }
  | { kind: "installed"; inPath: boolean; runtimeReady: boolean }
  | {
      kind: "shadowed";
      shadowedBy: string;
      inPath: boolean;
      runtimeReady: boolean;
    };

/**
 * The menu groups both platform templates assemble. Windows/Linux glue
 * them together in `buildDesktopMenu`; macOS splices in its app menu and
 * passes its palette-aware item factory and role deltas.
 */

/** The File menu: the conversation rows plus the platform's session tail. */
const fileMenu = (): MenuItemConstructorOptions => {
  const item = commandItem();
  return {
    id: "file",
    label: "File",
    submenu: [
      ...conversationFileMenuItems(item),
      ...sessionFileTail(item, installCliAction()),
    ],
  };
};

/** The Edit menu — shared whole. */
const editMenu = (): MenuItemConstructorOptions => ({
  id: "edit",
  label: "Edit",
  submenu: editMenuItems(commandItem()),
});

/** The View menu — shared whole bar the fullscreen chord. */
const viewMenu = (): MenuItemConstructorOptions => ({
  id: "view",
  label: "View",
  submenu: viewMenuItems(commandItem()),
});

export const windowMenu = (): MenuItemConstructorOptions => {
  const item = commandItem();
  return {
    id: "window",
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { role: "close" },
      separator(),
      item("Pop Out Conversation", { kind: "popOut" }),
      separator(),
      companionVisibilityItem(
        readCompanionHidden(),
        setCompanionSurfaceVisible,
      ),
      separator(),
      { role: "front" },
    ],
  };
};

export const helpMenu = (): MenuItemConstructorOptions => {
  const item = commandItem();
  return {
    id: "help",
    label: "Help",
    submenu: [
      ...(app.isPackaged
        ? [
            {
              label: "Check for Updates...",
              click: checkForUpdates,
            },
          ]
        : []),
      item("Send Feedback...", { kind: "shareFeedback" }),
      {
        label: "Cadet Documentation",
        click: () => {
          void shell.openExternal("https://mycadet.ai/docs");
        },
      },
      separator(),
      { label: `About ${app.name}`, click: openAboutWindow },
    ],
  };
};

/** The File menu's session tail: settings, the install row, login state, quit. */
const sessionFileTail = (
  item: MenuCommandItem,
  installCli: (() => void) | undefined,
): MenuItemConstructorOptions[] => [
  item("Settings...", { kind: "openSettings" }, !readOnboardingActive()),
  ...(app.isPackaged ? [installCliRow(installCli)] : []),
  separator(),
  hasCloudSession
    ? item("Log Out", { kind: "logout" })
    : item("Log In", { kind: "login" }),
  separator(),
  { role: "quit" },
];

let hasCloudSession = false;
let applyFn: () => void = () => {};

/**
 * The menu's Log In/Log Out toggle is this process's fact: it reads the
 * session-token store directly — the same store the OAuth flow and
 * sign-out write — and re-applies. The shells never carry it.
 */
export function setDesktopHasCloudSession(): void {
  const has = getSessionToken() !== null;
  if (hasCloudSession === has) return;
  hasCloudSession = has;
  applyFn();
}

/** Read per call so tests can stamp the platform. */
const isDarwin = (): boolean => process.platform === "darwin";

// Null until the first detection completes; the menu shows the Install item
// in the meantime (the install flow is safe to run from any state).
let cliPathState: CliPathMenuState | null = null;

/**
 * Re-runs the CLI wrapper detection and rebuilds the menu. Kick off after
 * startup provisioning so a version bump rewrites the rows without waiting
 * for the next menu-triggering event.
 */
export const refreshDesktopMenuCliPath = async (): Promise<void> => {
  // Only the wrapper family (macOS + Linux) drives the menu rows from a
  // detected state, and only packaged builds manage the shared wrapper.
  if (!isDarwin() && process.platform !== "linux") return;
  if (app.isPackaged) {
    try {
      cliPathState = await getCliPathInstallState();
    } catch {
      cliPathState = null;
    }
  }
  applyFn();
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
    applyFn();
    await flowDone;
    await refreshDesktopMenuCliPath();
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
              runWrapperCliInstallFlow,
            ),
          ]
        : []),
      cliPathFlowItem("Uninstall cadet Command", runUninstallCliCommandFlow),
    ];
  }
  return [
    cliPathFlowItem("Install cadet Command\u2026", runWrapperCliInstallFlow),
  ];
};

/** The app menu — About, updates, Settings, CLI rows, session, roles. */
const appMenu = (): MenuItemConstructorOptions => {
  const isDev = !app.isPackaged;
  const cliItems = cliPathItems();

  return {
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
        click: () => dispatchToFocused({ kind: "openSettings" }),
      },
      { type: "separator" },
      ...cliItems,
      ...(cliItems.length > 0 ? [{ type: "separator" as const }] : []),
      { role: "services" },
      { type: "separator" },
      hasCloudSession
        ? {
            label: "Log Out",
            click: () => dispatchToFocused({ kind: "logout" }),
          }
        : {
            label: "Log In",
            click: () => dispatchToFocused({ kind: "login" }),
          },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };
};

/** The File tail's install row: this process's CLI family's flow. */
const installCliAction = (): (() => void) | undefined => {
  if (!app.isPackaged || isDarwin()) {
    return undefined;
  }
  return process.platform === "win32"
    ? () => {
        void runLauncherCliInstallFlow();
      }
    : () => {
        void runWrapperCliInstallFlow();
      };
};

/**
 * The desktop menu template — the darwin app menu prepended on macOS.
 */
export const buildDesktopMenu = (): MenuItemConstructorOptions[] => {
  return [
    appMenu(),
    fileMenu(),
    editMenu(),
    viewMenu(),
    windowMenu(),
    helpMenu(),
  ];
};

/** Installs the desktop menu, popup IPC included. */
export const installDesktopMenu = (): void => {
  const apply = (): void => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildDesktopMenu()));
  };
  applyFn = apply;
  // The main window hides the native frame (`titleBarStyle: "hidden"`), which
  // hides the OS menu bar with it. The renderer draws the top-level titles in
  // its title bar (localizing them by id) and pops the real native submenus
  // here, so items, accelerators, and enabled states keep the one template
  // above as owner.
  handle(MENU_TITLES, z.tuple([]), () =>
    buildDesktopMenu().map((item) => ({
      id: String(item.id),
      label: String(item.label),
    })),
  );
  handle(
    MENU_POPUP,
    z.tuple([z.string(), z.number(), z.number()]),
    ([id, x, y], event) => {
      const submenu = buildDesktopMenu().find(
        (item) => item.id === id,
      )?.submenu;
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!Array.isArray(submenu) || !win || win.isDestroyed()) {
        return;
      }
      // The renderer reports CSS pixels; popup() takes DIPs, which differ
      // from CSS pixels by the page zoom.
      const zoom = event.sender.getZoomFactor();
      return new Promise<void>((resolve) => {
        Menu.buildFromTemplate(submenu).popup({
          window: win,
          x: Math.round(x * zoom),
          y: Math.round(y * zoom),
          callback: resolve,
        });
      });
    },
  );
  onHotkeyOverridesChange(apply);
  onOnboardingChange(apply);
  onCompanionHiddenChange(apply);
  // The session toggle is the menu's own fact: read once now, then re-read
  // on every token change the store announces.
  setDesktopHasCloudSession();
  onSessionTokenChange(() => {
    setDesktopHasCloudSession();
  });
  void refreshDesktopMenuCliPath();
  apply();
};
