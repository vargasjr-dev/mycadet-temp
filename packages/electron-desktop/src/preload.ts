import type { CadetBridge } from "@mycadet/ipc-contract";

import {
  createAppBridge,
  createBundleConfirmBridge,
  createCommandsBridge,
  createDeepLinksBridge,
  createDownloadsBridge,
  createHotkeysBridge,
  createLaunchAtLoginBridge,
  createMainWindowBridge,
  createNotificationsBridge,
  createTextBridge,
  createUpdateBridge,
  createVellumMigrationBridge,
} from "./preload/factories";
import { createAuthBridge } from "./preload/features/auth";
import { createAuxiliaryWindowSurfaces } from "./preload/features/auxiliary-windows";
import { createCompanionBridge } from "./preload/features/companion";
import {
  createDiagnosticsBridge,
  createFeedbackBridge,
} from "./preload/features/diagnostics";
import {
  createHelperAppsBridge,
  createHelperHotkeyBridge,
  createHelperInputBridge,
  createHelperSurface,
} from "./preload/features/helper";
import { createMenuBridge } from "./preload/features/menu";
import { createShareBridge } from "./preload/features/notifications-share";
import {
  createPermissionSetupBridge,
  createPermissionsSurface,
} from "./preload/features/permissions";
import { createPresenceSurfaces } from "./preload/features/presence";
import { createVoiceActivitySurface } from "./preload/features/voice-activity";
import { createFileOpenPreloadBridge } from "./file-open-preload";

/**
 * The shared desktop preload: one static object assembling every bridge
 * surface by importing the factories that build them — no install step, no
 * composition order to reason about, and no per-client core (the cores were
 * identical up to platform deltas, which the factories below branch on via
 * `process.platform`).
 *
 * The platform deltas live as spreads at the seams the contract marks
 * optional: macOS's raw-keyboard helper (hotkey hold flavor, apps, input),
 * its permission-setup guide and text undo, and Windows' native title-bar
 * overlay. A real preload runs once per platform, so branching at compose
 * time is exact.
 */
export const composeDesktopPreload = (): Partial<CadetBridge> => ({
  platform: "electron",
  app: createAppBridge(),
  commands: createCommandsBridge(),
  mainWindow: createMainWindowBridge(),
  text: createTextBridge(),
  auth: createAuthBridge(),
  hotkeys: createHotkeysBridge(),
  launchAtLogin: createLaunchAtLoginBridge(),
  deepLinks: createDeepLinksBridge(),
  update: createUpdateBridge(),
  vellumMigration: createVellumMigrationBridge(),
  bundleConfirm: createBundleConfirmBridge(),
  downloads: createDownloadsBridge(),
  notifications: createNotificationsBridge(),
  share: createShareBridge(),
  diagnostics: createDiagnosticsBridge(),
  feedback: createFeedbackBridge(),
  companion: createCompanionBridge(),
  menu: createMenuBridge(),
  ...createPresenceSurfaces(),
  ...createAuxiliaryWindowSurfaces(),
  ...createFileOpenPreloadBridge(),
  helper: {
    ...createHelperSurface(),
    hotkey: createHelperHotkeyBridge(),
    ...(process.platform === "darwin"
      ? { apps: createHelperAppsBridge(), input: createHelperInputBridge() }
      : {}),
  },
  permissions: {
    ...createPermissionsSurface(),
    ...(process.platform === "darwin"
      ? { setup: createPermissionSetupBridge() }
      : {}),
  },
  voiceActivity: createVoiceActivitySurface(),
});

declare global {
  // The bridge every desktop preload exposes — declared once here, where
  // the composition lives. Only clients/app relies on this declaration;
  // clients/web holds its own defensive (version-skew-tolerant) view built
  // from @mycadet/ipc-contract and must not couple to this package.
  interface Window {
    cadet: CadetBridge;
  }
}
