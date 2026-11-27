import type { CadetBridge } from "@mycadet/ipc-contract";
import { contextBridge } from "electron";

import {
  appBridge,
  bundleConfirmBridge,
  commandsBridge,
  deepLinksBridge,
  downloadsBridge,
  hotkeysBridge,
  launchAtLoginBridge,
  mainWindowBridge,
  mainWindowSetTitleBarOverlay,
  notificationsBridge,
  textBridge,
  textUndoInFrontApp,
  updateBridge,
  vellumMigrationBridge,
} from "./preload/factories";
import { authBridge } from "./preload/features/auth";
import { auxiliaryWindowSurfaces } from "./preload/features/auxiliary-windows";
import { companionBridge } from "./preload/features/companion";
import {
  diagnosticsBridge,
  feedbackBridge,
} from "./preload/features/diagnostics";
import {
  helperApps,
  helperHotkey,
  helperInput,
  helperSurface,
} from "./preload/features/helper";
import { menuBridge } from "./preload/features/menu";
import { shareBridge } from "./preload/features/notifications-share";
import {
  permissionSetup,
  permissionsSurface,
} from "./preload/features/permissions";
import { presenceSurfaces } from "./preload/features/presence";
import { voiceActivitySurface } from "./preload/features/voice-activity";
import { fileOpenSurfaces } from "./file-open-preload";

/**
 * The shared desktop preload: one static object assembling every bridge
 * surface by importing the surface objects themselves — no install step, no
 * composition order to reason about, no per-client core, and no platform
 * branches. Every surface ships every method on every platform; the main
 * process serves what its platform supports (the shared main modules
 * register their channels everywhere, with internal guards where a
 * capability is platform-specific).
 */
export const desktopPreload: Partial<CadetBridge> = {
  platform: "electron",
  app: appBridge,
  commands: commandsBridge,
  mainWindow: {
    ...mainWindowBridge,
    setTitleBarOverlay: mainWindowSetTitleBarOverlay,
  },
  text: {
    ...textBridge,
    undoInFrontApp: textUndoInFrontApp,
  },
  auth: authBridge,
  hotkeys: hotkeysBridge,
  launchAtLogin: launchAtLoginBridge,
  deepLinks: deepLinksBridge,
  update: updateBridge,
  vellumMigration: vellumMigrationBridge,
  bundleConfirm: bundleConfirmBridge,
  downloads: downloadsBridge,
  notifications: notificationsBridge,
  share: shareBridge,
  diagnostics: diagnosticsBridge,
  feedback: feedbackBridge,
  companion: companionBridge,
  menu: menuBridge,
  ...presenceSurfaces,
  ...auxiliaryWindowSurfaces,
  ...fileOpenSurfaces,
  helper: {
    ...helperSurface,
    hotkey: helperHotkey,
    apps: helperApps,
    input: helperInput,
  },
  permissions: {
    ...permissionsSurface,
    setup: permissionSetup,
  },
  voiceActivity: voiceActivitySurface,
};

// Every desktop shim's preload is a one-line import of this module: it
// exposes the bridge under the contract's key.
contextBridge.exposeInMainWorld("cadet", desktopPreload);

declare global {
  interface Window {
    cadet: CadetBridge;
  }
}
