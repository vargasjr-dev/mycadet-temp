import { app, BrowserWindow, Notification, ShareMenu } from "electron";

import {
  hasPendingDeepLinks,
  hasPendingFiles,
  installDictationOverlay,
  ensureMainWindowVisible,
  registerCompanionSurfaceSync,
  startApp,
} from "@mycadet/electron-desktop";
import log from "@mycadet/electron-desktop/app-logger";

import { installDock } from "./dock";
import { hostBashExecutor } from "./executors/host-bash-adapter";
import { createHostCuExecutor } from "./executors/host-cu-executor";
import { shutdownSharedCuHelper } from "./sidecar/shared-cu-helper";
import { trayRuntime } from "./tray.client";
import { installEscapeMonitor, setDictationRecording } from "./escape-monitor";
import { installHotkeyHelper } from "./hotkey-helper";
import { showCompanionCoachmarks } from "./companion-window";
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
  platform: "mac-electron",
  titleBarMode: "hidden",
  hostProxy: {
    interfaceId: "macos",
    supports: { windowCapture: true, sequence: true, coachmarks: true },
    bashExecutor: hostBashExecutor,
    hostCu: {
      executor: createHostCuExecutor({
        showCoachmarks: showCompanionCoachmarks,
      }),
      teardown: shutdownSharedCuHelper,
    },
  },
  tray: { runtime: trayRuntime },
  share: {
    present: ({ filePath, sender }) => {
      // ShareMenu wraps the native share sheet; popup's anchor option is
      // `window` (the documented `browserWindow` name is ignored at runtime).
      const shareMenu = new ShareMenu({ filePaths: [filePath] });
      shareMenu.popup({
        window: BrowserWindow.fromWebContents(sender) ?? undefined,
      });
    },
  },
  precheck: async () => {
    if (hasPendingFiles() || hasPendingDeepLinks()) {
      markRelocationSkipped();
      return false;
    }
    return relocateToApplicationsFolder();
  },
  ...(nativeNotifications ? { notifications: nativeNotifications } : {}),
  async setup() {
    installDock();

    installHotkeyHelper();
    installCompanionPermissionGuide();
    installTextInsertionIpc();
    registerCompanionSurfaceSync(setCompanionSurfaceVisible);
    installDictationOverlay({ onRecordingLifecycle: setDictationRecording });
    installCompanionWindow();
    if (nativeNotifications) {
      Notification.isSupported();
      ensureNotifierDelegate();
      registerNativeNotificationCategories();
      app.on("before-quit", restoreNotifierDelegate);
    }
    installEscapeMonitor();
    syncCompanionSurface();
    void promptToRelocateIfStranded().catch((err: unknown) => {
      log.error("[app] relocation prompt failed:", err);
    });
    app.on("activate", () => {
      ensureMainWindowVisible();
    });
  },
});
