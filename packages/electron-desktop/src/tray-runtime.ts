import path from "node:path";

import { app, nativeImage, shell, type NativeImage } from "electron";

import { openAboutWindow } from "./about";
import { acceleratorOption } from "./commands";
import { configureStatusIconFallback } from "./status-icon";
import {
  configureTrayModel,
  installTray,
  type TrayMenuIcon,
} from "./tray-model";
import { readOnboardingActive } from "./window-state";
import {
  MENU_ICON_CIRCLECHECK,
  MENU_ICON_MESSAGECIRCLE,
  MENU_ICON_MESSAGECIRCLEPLUS,
  MENU_ICON_MESSAGESQUARE,
  MENU_ICON_POWER,
  MENU_ICON_REFRESHCW,
  MENU_ICON_SETTINGS,
} from "./assets/menu-icons";
import { current, ensureVisible, toggleVisibility } from "./main-window";
import { menuIcon } from "./menu-icon";
import {
  DEFAULT_COMPANION_SIZE,
  type CadetCommand,
} from "@mycadet/ipc-contract";

const ICONS: Record<TrayMenuIcon, () => NativeImage> = {
  check: menuIcon(MENU_ICON_CIRCLECHECK),
  feedback: menuIcon(MENU_ICON_MESSAGECIRCLE),
  "new-conversation": menuIcon(MENU_ICON_MESSAGECIRCLEPLUS),
  conversation: menuIcon(MENU_ICON_MESSAGESQUARE),
  power: menuIcon(MENU_ICON_POWER),
  refresh: menuIcon(MENU_ICON_REFRESHCW),
  settings: menuIcon(MENU_ICON_SETTINGS),
};

let cachedIcon: NativeImage | null = null;

/**
 * The notification-area icon. The classic-desktop shells ship it beside the
 * resources: `tray.ico` on Windows (multi-resolution), a PNG elsewhere. Dev
 * runs read it from the repo before electron-builder copies it.
 */
export const getTrayIcon = (): NativeImage => {
  if (cachedIcon) {
    return cachedIcon;
  }
  const iconName = process.platform === "win32" ? "tray.ico" : "icon.png";
  const devRoot = process.platform === "win32" ? "resources" : "build";
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, iconName)
    : path.join(app.getAppPath(), devRoot, iconName);
  cachedIcon = nativeImage.createFromPath(iconPath);
  return cachedIcon;
};

const dispatch = (command: CadetCommand): void => {
  ensureVisible();
  const win = current();
  if (!win || win.isDestroyed()) {
    return;
  }
  const send = () => win.webContents.send("cadet:command", command);
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
};

/**
 * The notification-area tray the classic-desktop shells run. Neither has a
 * companion surface, so every companion field here is the inert answer rather
 * than an implementation — the size still has to be a real one, because the
 * tray model reads it to mark a radio item, and the menu it would appear in
 * is gated off by `companionSupported` anyway.
 */
export const installTrayRuntime = (): void => {
  const icon = getTrayIcon();
  configureStatusIconFallback(icon.isEmpty() ? null : icon);
  configureTrayModel({
    accelerator: acceleratorOption,
    companionSupported: () => false,
    companionHidden: () => true,
    companionSize: () => DEFAULT_COMPANION_SIZE,
    dispatch,
    icon: (icon) => ICONS[icon](),
    onboardingActive: readOnboardingActive,
    openComponentGallery: () => {
      void shell.openExternal("http://localhost:6007");
    },
    removePairedLabel: "Remove from this PC\u2026",
    setCompanionSize: () => undefined,
    setCompanionVisible: () => undefined,
  });
  installTray({
    ensureMainWindow: async () => ensureVisible(),
    openAbout: openAboutWindow,
    toggleMainWindow: toggleVisibility,
  });
};
