import { app, Notification } from "electron";

import {
  hasPendingDeepLinks,
  hasPendingFiles,
  installDictationOverlay,
  ensureMainWindowVisible,
  registerCompanionSurfaceSync,
  shareMenuPresenter,
  startApp,
} from "@mycadet/electron-desktop";
import log from "@mycadet/electron-desktop/app-logger";

import { installDock } from "./dock";
import { createHostCuExecutor } from "./executors/host-cu-executor";
import { shutdownSharedCuHelper } from "./sidecar/shared-cu-helper";
import { installEscapeMonitor, setDictationRecording } from "./escape-monitor";
import {
  handleHotkeyHelperState,
  installHotkeyHelper,
  makeClient,
} from "./hotkey-helper";
import { showCompanionCoachmarks } from "./companion-window";
import {
  replayCompanionIntro,
  setCompanionSurfaceSize,
  setCompanionSurfaceVisible,
} from "./companion-window";
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
import { permissionGuide } from "./permission-guide-values";
import { permissionsShell } from "./permissions-strategy";
import {
  installCompanionWindow,
  syncCompanionSurface,
} from "./companion-window";
import { installTextInsertionIpc } from "./textInsertion";
import {
  readCompanionHidden,
  readCompanionSize,
} from "@mycadet/electron-desktop/window-state";

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
  interfaceId: "macos",
  titleBarMode: "hidden",
  hostProxy: {
    supports: { windowCapture: true, sequence: true, coachmarks: true },
    hostCu: {
      executor: createHostCuExecutor({
        showCoachmarks: showCompanionCoachmarks,
      }),
      teardown: shutdownSharedCuHelper,
    },
  },
  tray: {
    companion: {
      // Every build of this shell has the companion surface; the tray
      // preference is the only thing that turns it off.
      supported: () => true,
      hidden: readCompanionHidden,
      size: readCompanionSize,
      setVisible: setCompanionSurfaceVisible,
      setSize: setCompanionSurfaceSize,
      replayIntro: replayCompanionIntro,
    },
  },
  share: { present: shareMenuPresenter() },
  permissions: permissionsShell,
  permissionGuide,
  dictation: {
    client: makeClient,
    onState: handleHotkeyHelperState,
    // The hold outlives the process boundary only if the helper is told —
    // the key must not survive a quit still believing it is armed.
    shutdownRequest: {
      method: "hotkey.modifierHold",
      params: { enable: false },
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
