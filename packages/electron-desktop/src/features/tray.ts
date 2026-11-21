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
import { readOnboardingActive } from "../window-state";
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
import {
  DEFAULT_COMPANION_SIZE,
  type CadetCommand,
  type CompanionSize,
  type CompanionSizeAxis,
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

/** The tray surfaces only the shell has. Absent fields take shared answers. */
export interface ShellTrayInputs {
  /**
   * The shell's own tray-menu icon renderer — a build that ships template
   * images or themed glyphs of its own. Absent, the shared theme-aware
   * renderer answers.
   */
  icon?: (icon: TrayMenuIcon) => NativeImage | undefined;
  /** The shell's companion-surface wiring. Absent, the surface doesn't exist. */
  companion?: {
    supported: () => boolean;
    hidden: () => boolean;
    size: (axis: CompanionSizeAxis) => CompanionSize;
    setVisible: (visible: boolean) => void;
    setSize: (axis: CompanionSizeAxis, size: CompanionSize) => void;
    replayIntro?: () => void;
  };
  /** The paired-device removal row's copy — the shell's own wording. */
  removePairedLabel?: string;
}

/**
 * The tray installs on every desktop. One model, assembled here: the shared
 * answers (accelerator, dispatch, onboarding, the component gallery) with
 * the shell's surfaces passed in where only it has them. The taskbar-button
 * surface rides along on every desktop — the overlay icon no-ops where the
 * OS has no taskbar buttons.
 */
export const install = (tray?: ShellTrayInputs): void => {
  const icon = getTrayIcon();
  configureStatusIconFallback(icon.isEmpty() ? null : icon);
  configureTrayModel({
    accelerator: acceleratorOption,
    companionSupported: tray?.companion?.supported ?? (() => false),
    companionHidden: tray?.companion?.hidden ?? (() => true),
    companionSize: tray?.companion?.size ?? (() => DEFAULT_COMPANION_SIZE),
    dispatch,
    icon: tray?.icon ?? ((menu) => ICONS[menu]()),
    onboardingActive: readOnboardingActive,
    openComponentGallery: () => {
      void shell.openExternal("http://localhost:6007");
    },
    removePairedLabel: tray?.removePairedLabel ?? "Remove from this PC\u2026",
    setCompanionSize: tray?.companion?.setSize ?? (() => undefined),
    setCompanionVisible: tray?.companion?.setVisible ?? (() => undefined),
    ...(tray?.companion?.replayIntro
      ? { replayCompanionIntro: tray.companion.replayIntro }
      : {}),
  });
  installTray({
    ensureMainWindow: async () => ensureVisible(),
    openAbout: openAboutWindow,
    toggleMainWindow: toggleVisibility,
  });
  installTaskbar({ getWindow: current });
};
