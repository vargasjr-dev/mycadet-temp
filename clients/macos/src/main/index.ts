import "./env-seed";
import { app, Notification } from "electron";

import { installCommandPaletteWindow } from "@mycadet/electron-desktop/command-palette-window";
import {
  installDictationOverlay,
  installPopoutWindows,
  installQuickInput,
} from "@mycadet/electron-desktop";
import { openAboutWindow } from "@mycadet/electron-desktop/about";
import { installAbout } from "./about.client";
import { installMacBundleWorkflow } from "./bundles";
import { handleBundleFile } from "@mycadet/electron-desktop/bundle-flow";
import { onFileOpen } from "@mycadet/electron-desktop/file-open";
import { installDownloads } from "@mycadet/electron-desktop";
import { installNotifications } from "@mycadet/electron-desktop/notifications";
import "./auxiliary-windows.client";
import { installDock } from "./dock";
import { installShare } from "./share";
import { installWindowAttentionFeature } from "./window-attention";
import { installEscapeMonitor, setDictationRecording } from "./escape-monitor";
import { installDiagnosticsIpc } from "./desktop-diagnostics";
import { installFeedbackIpc } from "@mycadet/electron-desktop";
import { installGlobalShortcuts } from "./global-shortcuts.client";
import { installHotkeyHelper } from "./hotkey-helper";
import { installHotkeysIpc } from "./hotkeys.client";
import {
  installImageContextMenu,
  installTextContextMenu,
} from "@mycadet/electron-desktop";
import { installLoginItem } from "./login-item.client";
import { installLoginItemIpc, startApp } from "@mycadet/electron-desktop";
import { installHostProxyBridge } from "./host-proxy-adapter";
import log from "@mycadet/electron-desktop/app-logger";

// Session tokens log through the same app logger (was session-token-store.client).
setSessionTokenLogger(log);
import {
  ensureVisible as ensureMainWindowVisible,
  installMainWindow,
  toggleVisibility as toggleMainWindowVisibility,
} from "./main-window";
import { installDesktopMenu } from "@mycadet/electron-desktop";
import { setSessionTokenLogger } from "@mycadet/electron-desktop/session-token-store";
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
import {
  hasPendingDeepLinks,
  hasPendingFiles,
  installNativeAuth,
  provisionCliForWrapper,
  refreshDesktopMenuCliPath,
  registerCompanionSurfaceSync,
  writeCliLocator,
} from "@mycadet/electron-desktop";

const isDev = !app.isPackaged;

// Dev-only: skip the real macOS Keychain for Chromium's `os_crypt` /
// Electron `safeStorage`.
if (isDev) {
  app.commandLine.appendSwitch("use-mock-keychain");
}

// Packaged builds all share the same package.json `name` (`@mycadet/macos`),
// so Electron resolves `app.getPath("userData")` to the same directory for
// every environment. This causes `requestSingleInstanceLock()` collisions
// when multiple environment builds (dev, staging, production) run side-by-side.
// startApp appends an environment suffix for non-production builds from the
// baked define; production keeps the original path for backwards compatibility.
declare const __CADET_ENVIRONMENT__: string;

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

startApp(
  log,
  async () => {
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

    installMacBundleWorkflow();
    onFileOpen(handleBundleFile);
    installHotkeysIpc();
    installDiagnosticsIpc();
    installLoginItem();
    installLoginItemIpc();
    installHotkeyHelper();
    installCompanionPermissionGuide(installPermissionsService());
    // The identity (assistant name) channel registers in startApp, before
    // this setup, so About, the Tray, and the main window see any name the
    // renderer publishes during bootstrap.
    installAbout();
    installFeedbackIpc();
    installTextInsertionIpc();
    installCommandPaletteWindow();
    // The shared desktop menu — the same installer the classic-desktop
    // shells ride, with every row wired inside the package (About, updates,
    // the CLI wrapper rows, the session toggle, onboarding, the companion
    // tail). This side registers the one action only it owns: the surface
    // sync the menu's Show Companion row and the tray both go through.
    registerCompanionSurfaceSync(setCompanionSurfaceVisible);
    installDesktopMenu();
    installQuickInput();
    installDictationOverlay({ onRecordingLifecycle: setDictationRecording });
    installCompanionWindow();
    installPopoutWindows();
    installGlobalShortcuts();
    installDock();
    installShare();
    // Files renderer downloads into ~/Downloads instead of prompting a Save
    // panel. Distinct from `installShare`, which is the "send elsewhere" intent.
    installDownloads();
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
    installNotifications();
    installWindowAttentionFeature();
    installEscapeMonitor();
    const teardownHostProxy = installHostProxyBridge();
    app.on("before-quit", teardownHostProxy);
    installTray({
      toggleMainWindow: toggleMainWindowVisibility,
      ensureMainWindow: ensureMainWindowVisible,
      openAbout: openAboutWindow,
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
  {
    ensureVisible: ensureMainWindowVisible,
    // Launches arrive through `open-url`/`open-file` events on this shell,
    // never through argv.
    initialArgv: [],
    // Dev packs the renderer dists (see `bun run dev`) and serves them
    // through the same `app://mycadet.ai` origin as packaged builds, so
    // the handler and the gateway guard are unconditional.
    rendererUsesAppProtocol: () => true,
    environmentName:
      typeof __CADET_ENVIRONMENT__ === "string"
        ? __CADET_ENVIRONMENT__
        : "production",
    ...(nativeNotifications ? { notifications: nativeNotifications } : {}),
    provisionCli: () => {
      if (!app.isPackaged) {
        return;
      }
      // Refresh the PATH-wrapper locator every launch so app moves and
      // version bumps self-heal even if no CLI invocation happens this session.
      writeCliLocator();
      // Wrapper users also get the pinned CLI provisioned eagerly so a
      // version bump rewrites the locator now (and prunes old versions)
      // rather than after the next in-app CLI action.
      void provisionCliForWrapper()
        .then((provisioned) =>
          provisioned ? refreshDesktopMenuCliPath() : undefined,
        )
        .catch((err: unknown) => {
          log.error("[app] startup CLI provisioning failed:", err);
        });
    },
  },
);

app.on("second-instance", () => {
  // Behavior change vs prior code path: previously a second-instance
  // launch was a no-op when the main window had been destroyed. Now
  // we recreate so the user always sees a window in response to
  // re-launching the app. File argv routes through startApp's file-open
  // wiring.
  ensureMainWindowVisible();
});

app.on("web-contents-created", (_event, contents) => {
  // Right-click on an image → native "Copy Image" menu. Wired here so every
  // surface (main window, popouts, command palette, child popups) gets it.
  // startApp's own web-contents subscription carries the security wiring.
  installImageContextMenu(contents);
  installTextContextMenu(contents);
});
