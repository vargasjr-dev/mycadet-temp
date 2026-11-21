import { shell, type NativeImage } from "electron";

import type {
  TrayMenuIcon,
  TrayModelRuntime,
} from "@mycadet/electron-desktop/tray-model";
import {
  readCompanionHidden,
  readCompanionSize,
  readOnboardingActive,
} from "@mycadet/electron-desktop/window-state";

import {
  MENU_ICON_CIRCLECHECK,
  MENU_ICON_MESSAGECIRCLE,
  MENU_ICON_MESSAGECIRCLEPLUS,
  MENU_ICON_MESSAGESQUARE,
  MENU_ICON_POWER,
  MENU_ICON_REFRESHCW,
  MENU_ICON_SETTINGS,
} from "./assets/menu-icons";
import { acceleratorOption } from "@mycadet/electron-desktop/commands";
import {
  replayCompanionIntro,
  setCompanionSurfaceSize,
  setCompanionSurfaceVisible,
} from "./companion-window";
import { dispatchToMain } from "@mycadet/electron-desktop";
import { menuIcon } from "./menu-icon";

const ICONS: Record<TrayMenuIcon, NativeImage> = {
  check: menuIcon(MENU_ICON_CIRCLECHECK),
  feedback: menuIcon(MENU_ICON_MESSAGECIRCLE),
  "new-conversation": menuIcon(MENU_ICON_MESSAGECIRCLEPLUS),
  conversation: menuIcon(MENU_ICON_MESSAGESQUARE),
  power: menuIcon(MENU_ICON_POWER),
  refresh: menuIcon(MENU_ICON_REFRESHCW),
  settings: menuIcon(MENU_ICON_SETTINGS),
};

export const trayRuntime: TrayModelRuntime = {
  accelerator: acceleratorOption,
  // Every build of this shell has the companion surface; the tray
  // preference is the only thing that turns it off.
  companionSupported: () => true,
  companionHidden: readCompanionHidden,
  companionSize: readCompanionSize,
  dispatch: dispatchToMain,
  icon: (icon) => ICONS[icon],
  onboardingActive: readOnboardingActive,
  openComponentGallery: () => {
    void shell.openExternal("http://localhost:6007");
  },
  removePairedLabel: "Remove from this Mac\u2026",
  replayCompanionIntro,
  setCompanionSize: setCompanionSurfaceSize,
  setCompanionVisible: setCompanionSurfaceVisible,
};
