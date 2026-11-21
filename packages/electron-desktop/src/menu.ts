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
import type { IpcHandle } from "./ipc";
import { readOnboardingActive } from "./window-state";

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
  options: { fullscreenAccelerator?: string } = {},
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
  options.fullscreenAccelerator
    ? { role: "togglefullscreen", accelerator: options.fullscreenAccelerator }
    : { role: "togglefullscreen" },
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

export interface DesktopCliPathMenuDeps {
  /** Kicks a fresh detection; the menu renders Install until it resolves. */
  state: () => Promise<CliPathMenuState>;
  /** True while an install/repair/uninstall flow runs (rows go inert). */
  inFlight: () => boolean;
  install: () => Promise<void>;
  uninstall: () => Promise<void>;
}

/**
 * The menu groups both platform templates assemble. Windows/Linux glue
 * them together in `buildDesktopMenu`; macOS splices in its app menu and
 * passes its palette-aware item factory and role deltas.
 */

/** The File menu: the conversation rows plus the platform's session tail. */
export const fileMenu = (
  options: { sessionTail?: MenuItemConstructorOptions[] } = {},
): MenuItemConstructorOptions => {
  const item = commandItem();
  return {
    id: "file",
    label: "File",
    submenu: [
      ...conversationFileMenuItems(item),
      ...(options.sessionTail ?? []),
    ],
  };
};

/** The Edit menu — shared whole. */
export const editMenu = (): MenuItemConstructorOptions => ({
  id: "edit",
  label: "Edit",
  submenu: editMenuItems(commandItem()),
});

/** The View menu — shared whole bar the fullscreen chord. */
export const viewMenu = (
  options: { fullscreenAccelerator?: string } = {},
): MenuItemConstructorOptions => ({
  id: "view",
  label: "View",
  submenu: viewMenuItems(commandItem(), {
    fullscreenAccelerator: options.fullscreenAccelerator,
  }),
});

export interface WindowMenuOptions {
  /** macOS zooms in place of the frameless close role. */
  zoomRole?: boolean;
  /** Rows appended after a separator (macOS: companion toggle, front). */
  tail?: MenuItemConstructorOptions[];
}

export const windowMenu = ({
  zoomRole,
  tail,
}: WindowMenuOptions = {}): MenuItemConstructorOptions => {
  const item = commandItem();
  return {
    id: "window",
    label: "Window",
    submenu: [
      { role: "minimize" },
      zoomRole ? { role: "zoom" } : { role: "close" },
      separator(),
      item("Pop Out Conversation", { kind: "popOut" }),
      ...(tail?.length ? [separator(), ...tail] : []),
    ],
  };
};

export interface HelpMenuOptions {
  openAbout?: () => void;
  checkForUpdates?: () => void;
  /** macOS checks for updates from its app menu instead. */
  updatesRow?: boolean;
}

export const helpMenu = (
  options: HelpMenuOptions = {},
): MenuItemConstructorOptions => {
  const item = commandItem();
  return {
    id: "help",
    label: "Help",
    submenu: [
      ...(app.isPackaged && options.updatesRow !== false
        ? [
            {
              label: "Check for Updates...",
              enabled: options.checkForUpdates !== undefined,
              click: options.checkForUpdates,
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
      ...(options.openAbout
        ? [
            separator(),
            { label: `About ${app.name}`, click: options.openAbout },
          ]
        : []),
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

export interface DesktopMenuDeps {
  handle: IpcHandle;
  openAbout: () => void;
  checkForUpdates?: () => void;
  installCli?: () => void;
  /**
   * macOS only: the CLI wrapper's install state drives the app menu's
   * Install/Repair/Uninstall rows. Windows/Linux render the single
   * `installCli` row instead.
   */
  cliPath?: DesktopCliPathMenuDeps;
  /**
   * macOS only: rows appended to the Window menu after a separator (the
   * companion toggle and the front role ride here from the client).
   */
  windowMenuTail?: MenuItemConstructorOptions[];
  /**
   * macOS only: re-apply when the companion surface's hidden flag moves
   * from somewhere else (tray, its own right-click).
   */
  onCompanionHiddenChange?: (apply: () => void) => () => void;
  /**
   * Re-apply when onboarding flips (the Settings row's enabled state);
   * each client owns its window-side wiring.
   */
  onOnboardingChange?: (apply: () => void) => void;
}

let hasCloudSession = false;
let applyFn: () => void = () => {};

/**
 * The menu's Log In/Log Out toggle is this process's fact: the wiring
 * derives it from the session-token store and publishes here.
 */
export function setDesktopHasCloudSession(has: boolean): void {
  if (hasCloudSession === has) return;
  hasCloudSession = has;
  applyFn();
}

const MAC_FULLSCREEN_ACCELERATOR = "Control+Command+F";

/** Read per call so tests can stamp the platform. */
const isDarwin = (): boolean => process.platform === "darwin";

// Null until the first detection completes; the menu shows the Install item
// in the meantime (the install flow is safe to run from any state).
let cliPathDeps: DesktopCliPathMenuDeps | null = null;
let cliPathState: CliPathMenuState | null = null;

/**
 * Re-runs the CLI wrapper detection and rebuilds the menu. Kick off after
 * startup provisioning so a version bump rewrites the rows without waiting
 * for the next menu-triggering event.
 */
export const refreshDesktopMenuCliPath = async (): Promise<void> => {
  if (!cliPathDeps) return;
  if (app.isPackaged) {
    try {
      cliPathState = await cliPathDeps.state();
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
  enabled: !cliPathDeps?.inFlight(),
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
  if (!app.isPackaged || !cliPathDeps) return [];
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
        ? [cliPathFlowItem("Repair cadet Command\u2026", cliPathDeps.install)]
        : []),
      cliPathFlowItem("Uninstall cadet Command", cliPathDeps.uninstall),
    ];
  }
  return [cliPathFlowItem("Install cadet Command\u2026", cliPathDeps.install)];
};

/** The macOS app menu — About, updates, Settings, CLI rows, session, roles. */
const macAppMenu = ({
  openAbout,
  checkForUpdates,
}: Pick<
  DesktopMenuDeps,
  "openAbout" | "checkForUpdates"
>): MenuItemConstructorOptions => {
  const isDev = !app.isPackaged;
  const cliItems = cliPathItems();

  return {
    label: app.name,
    submenu: [
      {
        label: `About ${app.name}`,
        click: () => {
          openAbout();
        },
      },
      ...(!isDev
        ? [
            {
              label: "Check for Updates\u2026",
              click: () => {
                checkForUpdates?.();
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

/** The desktop menu template — the darwin app menu prepended on macOS. */
export const buildDesktopMenu = ({
  openAbout,
  checkForUpdates,
  installCli,
  windowMenuTail,
}: Omit<
  DesktopMenuDeps,
  "handle" | "onOnboardingChange" | "cliPath"
>): MenuItemConstructorOptions[] => {
  const item = commandItem();

  if (isDarwin()) {
    // File/Edit/View/Window/Help are the shared groups; the macOS deltas
    // ride the app menu, the fullscreen chord, the zoom role, and the
    // companion/front rows the client passes in.
    return [
      macAppMenu({ openAbout, checkForUpdates }),
      fileMenu(),
      editMenu(),
      viewMenu({ fullscreenAccelerator: MAC_FULLSCREEN_ACCELERATOR }),
      windowMenu({ zoomRole: true, tail: windowMenuTail }),
      helpMenu({ updatesRow: false }),
    ];
  }

  return [
    fileMenu({ sessionTail: sessionFileTail(item, installCli) }),
    editMenu(),
    viewMenu(),
    windowMenu(),
    helpMenu({ openAbout, checkForUpdates }),
  ];
};

/** Installs the desktop menu, popup IPC included. */
export const installDesktopMenu = (options: DesktopMenuDeps): void => {
  const apply = (): void => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildDesktopMenu({
          openAbout: options.openAbout,
          checkForUpdates: options.checkForUpdates,
          installCli: options.installCli,
          windowMenuTail: options.windowMenuTail,
        }),
      ),
    );
  };
  applyFn = apply;
  cliPathDeps = options.cliPath ?? null;
  // The main window hides the native frame (`titleBarStyle: "hidden"`), which
  // hides the OS menu bar with it. The renderer draws the top-level titles in
  // its title bar (localizing them by id) and pops the real native submenus
  // here, so items, accelerators, and enabled states keep the one template
  // above as owner.
  options.handle(MENU_TITLES, z.tuple([]), () =>
    buildDesktopMenu(options).map((item) => ({
      id: String(item.id),
      label: String(item.label),
    })),
  );
  options.handle(
    MENU_POPUP,
    z.tuple([z.string(), z.number(), z.number()]),
    ([id, x, y], event) => {
      const submenu = buildDesktopMenu(options).find(
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
  options.onOnboardingChange?.(apply);
  options.onCompanionHiddenChange?.(apply);
  if (options.cliPath) void refreshDesktopMenuCliPath();
  apply();
};
