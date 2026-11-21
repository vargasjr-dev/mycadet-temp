import { installAuxiliaryWindowConfiguration } from "./auxiliary-windows.client";
import { app, Notification } from "electron";

import {
  configureNativeAuth,
  hasPendingDeepLinks,
  hasPendingFiles,
  installDictationOverlay,
  installLoginItem,
  installLoginItemIpc,
  installNativeAuth,
  openAboutWindow,
  registerCompanionSurfaceSync,
  startApp,
} from "@mycadet/electron-desktop";
import log from "@mycadet/electron-desktop/app-logger";

import { installDock } from "./dock";
import { installShare } from "./share";
import { installHostProxyBridge } from "./host-proxy-adapter";
import { installEscapeMonitor, setDictationRecording } from "./escape-monitor";
import { installHotkeyHelper } from "./hotkey-helper";
import {
  ensureVisible as ensureMainWindowVisible,
  installMainWindow,
  toggleVisibility as toggleMainWindowVisibility,
} from "./main-window";
import {
  promptToRelocateIfStranded,
  relocateToApplicationsFolder,
} from "./move-to-applications";
import { markRelocationSkipped } from "./install-location";
import {
  createNativeNotificationFactory,
  registerNativeNotificationCategories,
} from "./native-notifications";
import {
  ensureNotifierDelegate,
  isNotifierSupported,
  restoreNotifierDelegate,
} from "./notifier";
import { installCompanionPermissionGuide } from "./companion-permission-guide";
import {
  installCompanionWindow,
  setCompanionSurfaceVisible,
  syncCompanionSurface,
} from "./companion-window";
import { installTextInsertionIpc } from "./textInsertion";
import { installTray } from "./tray.client";

installAuxiliaryWindowConfiguration();

const isDev = !app.isPackaged;

// Dev-only: skip the real macOS Keychain for Chromium's `os_crypt` /
// Electron `safeStorage`.
if (isDev) {
  app.commandLine.appendSwitch("use-mock-keychain");
}

// The addon takes the notifications the assistant avatar can ride on only
// when it says it can have them: an unbundled run loads it fine and then
// reports unsupported, because UNUserNotificationCenter raises there.
// `isSupported` ships with `create` rather than being left to the shared
// module's default; see the delegate rule in README.md.
const nativeNotifications = isNotifierSupported()
  ? createNativeNotificationFactory()
  : null;

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

startApp({
  precheck: async () => {
    if (hasPendingFiles() || hasPendingDeepLinks()) {
      markRelocationSkipped();
      return false;
    }
    return relocateToApplicationsFolder();
  },
  ensureVisible: ensureMainWindowVisible,
  initialArgv: [],
  rendererUsesAppProtocol: () => true,
  ...(nativeNotifications ? { notifications: nativeNotifications } : {}),
  async setup() {
    installLoginItem();
    installLoginItemIpc();
    installHotkeyHelper();
    installCompanionPermissionGuide();
    installTextInsertionIpc();
    registerCompanionSurfaceSync(setCompanionSurfaceVisible);
    installDictationOverlay({ onRecordingLifecycle: setDictationRecording });
    installCompanionWindow();
    installDock();
    installShare();
    if (nativeNotifications) {
      Notification.isSupported();
      ensureNotifierDelegate();
      registerNativeNotificationCategories();
      app.on("before-quit", restoreNotifierDelegate);
    }
    installEscapeMonitor();
    const teardownHostProxy = installHostProxyBridge();
    app.on("before-quit", teardownHostProxy);
    installTray({
      toggleMainWindow: toggleMainWindowVisibility,
      ensureMainWindow: ensureMainWindowVisible,
      openAbout: openAboutWindow,
    });
    configureNativeAuth({
      activateWindow: () => {
        app.focus({ steal: true });
        ensureMainWindowVisible();
      },
    });
    installNativeAuth();
    installMainWindow();
    syncCompanionSurface();
    void promptToRelocateIfStranded().catch((err: unknown) => {
      log.error("[app] relocation prompt failed:", err);
    });
    app.on("activate", () => {
      ensureMainWindowVisible();
    });
  },
});
