/**
 * The desktop menu bar, shared by the three clients.
 *
 * Windows and Linux ship byte-identical templates — `buildDesktopMenu` is
 * that template, and `installDesktopMenu` its installer (the frameless
 * windows pop native submenus through the renderer, so the install also
 * owns the popup IPC). macOS splices its app menu in front and passes its
 * palette-aware item factory and role deltas to the same group builders:
 * one owner per row, per platform deltas only.
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

/** The Windows/Linux template — File/Edit/View/Window/Help. */
export const buildDesktopMenu = ({
  openAbout,
  checkForUpdates,
  installCli,
}: Omit<
  DesktopMenuDeps,
  "handle" | "onOnboardingChange"
>): MenuItemConstructorOptions[] => {
  const item = commandItem();

  return [
    fileMenu({ sessionTail: sessionFileTail(item, installCli) }),
    editMenu(),
    viewMenu(),
    windowMenu(),
    helpMenu({ openAbout, checkForUpdates }),
  ];
};

/** Installs the Windows/Linux menu, popup IPC included. */
export const installDesktopMenu = (options: DesktopMenuDeps): void => {
  const apply = (): void => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildDesktopMenu(options)));
  };
  applyFn = apply;
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
  apply();
};
