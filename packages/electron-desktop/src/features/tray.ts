import path from "node:path";

import { app, nativeImage, shell, type NativeImage } from "electron";

import { openAboutWindow } from "../about";
import { acceleratorOption } from "../commands";
import { current, ensureVisible, toggleVisibility } from "../main-window";
import { configureStatusIconFallback } from "../status-icon";
import {
  configureTrayModel,
  installTray,
  type TrayMenuIcon,
} from "../tray-model";
import {
  readCompanionHidden,
  readCompanionSize,
  readOnboardingActive,
} from "../window-state";
import {
  replayCompanionIntro,
  setCompanionSurfaceSize,
  setCompanionSurfaceVisible,
} from "./companion-window";
import { installTaskbar } from "../taskbar";
import {
  MENU_ICON_CIRCLECHECK,
  MENU_ICON_MESSAGECIRCLE,
  MENU_ICON_MESSAGECIRCLEPLUS,
  MENU_ICON_MESSAGESQUARE,
  MENU_ICON_POWER,
  MENU_ICON_REFRESHCW,
  MENU_ICON_SETTINGS,
} from "../assets/menu-icons";
import { menuIcon } from "../menu-icon";
import { type CadetCommand } from "@mycadet/ipc-contract";

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
const getTrayIcon = (): NativeImage => {
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
 * The tray installs on every desktop. One model, assembled here: the shared
 * answers (accelerator, dispatch, onboarding, the component gallery) with the
 * package's own companion answers — every desktop has the surface, and the
 * hidden preference is what turns it off. The taskbar-button surface rides
 * along on every desktop — the overlay icon no-ops where the OS has no
 * taskbar buttons.
 */
export const install = (): void => {
  const icon = getTrayIcon();
  configureStatusIconFallback(icon.isEmpty() ? null : icon);
  configureTrayModel({
    accelerator: acceleratorOption,
    // Every desktop has the companion surface, so the rows answer from the
    // package's own modules — there is no per-shell companion input.
    companionSupported: () => true,
    companionHidden: readCompanionHidden,
    companionSize: readCompanionSize,
    dispatch,
    icon: (menu) => ICONS[menu](),
    onboardingActive: readOnboardingActive,
    openComponentGallery: () => {
      void shell.openExternal("http://localhost:6007");
    },
    removePairedLabel: "Remove from this device\u2026",
    replayCompanionIntro,
    setCompanionSize: setCompanionSurfaceSize,
    setCompanionVisible: setCompanionSurfaceVisible,
  });
  installTray({
    ensureMainWindow: async () => ensureVisible(),
    openAbout: openAboutWindow,
    toggleMainWindow: toggleVisibility,
  });
  installTaskbar({ getWindow: current });
};
