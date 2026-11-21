import "./auxiliary-windows.client";
import { app, Notification } from "electron";

import {
  configureNativeAuth,
  hasPendingDeepLinks,
  hasPendingFiles,
  installDictationOverlay,
  installLoginItemIpc,
  installNativeAuth,
  openAboutWindow,
  registerCompanionSurfaceSync,
  startApp,
} from "@mycadet/electron-desktop";
import { setSessionTokenLogger } from "@mycadet/electron-desktop/session-token-store";
import log from "@mycadet/electron-desktop/app-logger";

// Session tokens log through the same app logger.
setSessionTokenLogger(log);

import { installDock } from "./dock";
import { installShare } from "./share";
import { installHostProxyBridge } from "./host-proxy-adapter";
import { installEscapeMonitor, setDictationRecording } from "./escape-monitor";
import { installHotkeyHelper } from "./hotkey-helper";
import { installLoginItem } from "./login-item.client";
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
import { installPermissionsService } from "./permissions-service";
import { installCompanionPermissionGuide } from "./companion-permission-guide";
import {
  installCompanionWindow,
  setCompanionSurfaceVisible,
  syncCompanionSurface,
} from "./companion-window";
import { installTextInsertionIpc } from "./textInsertion";
import { installTray } from "./tray.client";

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
  ensureVisible: ensureMainWindowVisible,
  // Launches arrive through `open-url`/`open-file` events on this shell,
  // never through argv.
  initialArgv: [],
  // Dev packs the renderer dists (see `bun run dev`) and serves them
  // through the same `app://mycadet.ai` origin as packaged builds, so
  // the handler and the gateway guard are unconditional.
  rendererUsesAppProtocol: () => true,
  ...(nativeNotifications ? { notifications: nativeNotifications } : {}),
  async setup() {
    // Install into /Applications before any other setup. On the first packaged
    // launch from a mounted DMG (or ~/Downloads), the app silently moves itself
    // there and relaunches — the "double-click to install" half of the DMG flow.
    // Skip it when a file or deep link triggered the launch: those events are
    // buffered in-process and would be lost during the relaunch.
    if (hasPendingFiles() || hasPendingDeepLinks()) {
      markRelocationSkipped();
    } else if (await relocateToApplicationsFolder()) {
      return;
    }

    installLoginItem();
    installLoginItemIpc();
    installHotkeyHelper();
    installCompanionPermissionGuide(installPermissionsService());
    // The identity (assistant name) channel registers in startApp, before
    // this setup, so About, the Tray, and the main window see any name the
    // renderer publishes during bootstrap.
    installTextInsertionIpc();
    // The shared desktop menu — the same installer the classic-desktop
    // shells ride, with every row wired inside the package (About, updates,
    // the CLI wrapper rows, the session toggle, onboarding, the companion
    // tail). This side registers the one action only it owns: the surface
    // sync the menu's Show Companion row and the tray both go through.
    registerCompanionSurfaceSync(setCompanionSurfaceVisible);
    installDictationOverlay({ onRecordingLifecycle: setDictationRecording });
    installCompanionWindow();
    installDock();
    installShare();
    if (nativeNotifications) {
      // Electron builds its notification presenter lazily, on the first
      // `Notification.isSupported()` or `new Notification()`, and the presenter
      // claims the notification center's delegate and discards responses for
      // identifiers it does not own. Building it here, with nothing on screen,
      // and re-asserting the addon's delegate straight after leaves the addon
      // in front of it for the life of the process, forwarding what it does not
      // own. The categories are then written after the presenter exists, so
      // Electron's own category read-modify-write cannot land on top of them.
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

    // After the main window, so the surface opens over a running app rather
    // than being the first thing on screen at launch. Open from here on,
    // unless the user has hidden it from the tray, and on screen whenever the
    // app itself is not in front: it stands in for the app while the user is
    // working somewhere else, and steps off while Cadet is the frontmost app
    // with its window showing.
    //
    // A launch that has nobody signed in yet leaves it closed, and the window
    // that opens it later is the app's own, once it has an assistant to
    // publish.
    syncCompanionSurface();

    // Runs after the main window so the recovery dialog has a window to sit in
    // front of, and so a user who declines lands on a working app rather than
    // an empty screen. A packaged app outside /Applications cannot update, and
    // the relocation at the head of this block is the only thing that would
    // have fixed it.
    void promptToRelocateIfStranded().catch((err: unknown) => {
      log.error("[app] relocation prompt failed:", err);
    });

    // Dock-icon click / Cmd-Tab re-activation: bring the main window
    // back to front, recreating it if it was previously closed. The
    // primitive handles both the destroyed-window and the
    // visible-but-not-focused cases, so we don't need to branch here
    // on auxiliary window counts the way the old check did.
    app.on("activate", () => {
      ensureMainWindowVisible();
    });
  },
});
