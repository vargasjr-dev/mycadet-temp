import type { CadetBridge } from "@mycadet/ipc-contract";
import { contextBridge } from "electron";

import {
  appBridge,
  bundleConfirmBridge,
  commandsBridge,
  createNotificationsBridge,
  deepLinksBridge,
  downloadsBridge,
  hotkeysBridge,
  launchAtLoginBridge,
  mainWindowBridge,
  mainWindowSetTitleBarOverlay,
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
  helperHotkeyChord,
  helperHotkeyHold,
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
 * composition order to reason about, and no per-client core (the cores were
 * identical up to platform deltas, which branch here via `process.platform`).
 *
 * The platform deltas live as spreads at the seams the contract marks
 * optional: macOS's raw-keyboard helper (hotkey hold flavor, apps, input),
 * its permission-setup guide and text undo, and Windows' native title-bar
 * overlay. A real preload runs once per platform, so branching at compose
 * time is exact. The only per-composition construction left is the
 * notifications bridge, which owns a publisher-session identity.
 */
export const composeDesktopPreload = (): Partial<CadetBridge> => {
  // Branch at compose time, not module load: a real preload runs once per
  // platform, and the parity tests recompose under a mocked platform.
  const isMacOS = process.platform === "darwin";
  const isWin32 = process.platform === "win32";
  return {
    platform: "electron",
    app: appBridge,
    commands: commandsBridge,
    mainWindow: {
      ...mainWindowBridge,
      ...(isWin32 ? { setTitleBarOverlay: mainWindowSetTitleBarOverlay } : {}),
    },
    text: {
      ...textBridge,
      ...(isMacOS ? { undoInFrontApp: textUndoInFrontApp } : {}),
    },
    auth: authBridge,
    hotkeys: hotkeysBridge,
    launchAtLogin: launchAtLoginBridge,
    deepLinks: deepLinksBridge,
    update: updateBridge,
    vellumMigration: vellumMigrationBridge,
    bundleConfirm: bundleConfirmBridge,
    downloads: downloadsBridge,
    notifications: createNotificationsBridge(),
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
      hotkey: isMacOS ? helperHotkeyHold : helperHotkeyChord,
      ...(isMacOS ? { apps: helperApps, input: helperInput } : {}),
    },
    permissions: {
      ...permissionsSurface,
      ...(isMacOS ? { setup: permissionSetup } : {}),
    },
    voiceActivity: voiceActivitySurface,
  };
};

// Every desktop shim's preload is a one-line import of this module: it
// composes the bridge and exposes it under the contract's key.
contextBridge.exposeInMainWorld("cadet", composeDesktopPreload());

declare global {
  interface Window {
    cadet: CadetBridge;
  }
}
