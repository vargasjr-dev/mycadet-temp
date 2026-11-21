import "./env-seed";

import { app, protocol, session, shell } from "electron";
import path from "node:path";

import {
  BUNDLES_DIR_NAME,
  CADET_PROTOCOL,
} from "@mycadet/electron-desktop/bundle-platform";
import {
  installCsp,
  registerAppProtocol,
  installGatewayRequestGuard,
  installPermissionHandler,
  registerCadetProtocol,
  startApp,
} from "@mycadet/electron-desktop";
import { resolveEnvironmentName } from "@mycadet/shared";

import {
  APP_HOST,
  APP_PROTOCOL,
  usesAppProtocolRenderer,
} from "@mycadet/electron-desktop";
import { resolveAllowedOrigin } from "@mycadet/electron-desktop/app-origin";
import { writeCliLocator } from "./cli-installer";
import { provisionCliForWrapper } from "./cli-path-installer";
import { install as installAuth } from "./features/auth";
import { install as installAuxiliaryWindows } from "./features/auxiliary-windows";
import { install as installBundles } from "./features/bundles";
import { install as installCommands } from "./features/commands";
import { install as installDeepLinks } from "./features/deep-links";
import { install as installDiagnostics } from "./features/diagnostics";
import { install as installDictation } from "./features/dictation";
import { install as installDownloads } from "./features/downloads";
import { install as installFileOpen } from "./features/file-open";
import { install as installHostProxy } from "./features/host-proxy";
import { install as installMainWindow } from "./features/main-window";
import { install as installNotifications } from "./features/notifications";
import { install as installPermissions } from "./features/permissions";
import { install as installPresence } from "./features/presence";
import { install as installShare } from "./features/share";
import { install as installVoiceModeChord } from "./features/voice-mode-chord";
import { install as installWindowAttention } from "./features/window-attention";
import { log } from "@mycadet/electron-desktop";
import { ensureVisible } from "./main-window";
import { installWebContentsSecurity } from "@mycadet/electron-desktop";

// Packaged builds all share the same package.json `name`, so Electron
// resolves `app.getPath("userData")` to the same directory for every
// environment. Append an environment suffix for non-production builds so
// dev/staging/production installs can run side-by-side; production keeps the
// original path for backwards compatibility.
const releaseChannel = resolveEnvironmentName();
if (app.isPackaged) {
  if (releaseChannel !== "production") {
    const base = app.getPath("userData");
    app.setPath("userData", `${base}-${releaseChannel}`);
  }
}

// Single-instance lock: relaunches focus the existing window instead of
// spawning a parallel main process. The second-instance handler fires on the
// instance that holds the lock (the primary). The instance that fails to
// acquire calls app.quit() and never reaches whenReady.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// In prod, register `app://` as a "standard" + "secure" scheme so that fetch,
// service workers, and same-origin policy treat it like https://.
// Must be called before app.whenReady().
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
  {
    scheme: CADET_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

startApp(log, () => {
  if (usesAppProtocolRenderer(app.isPackaged)) {
    registerAppProtocol();
    installGatewayRequestGuard({
      appOrigin: { protocol: `${APP_PROTOCOL}:`, host: APP_HOST },
      resolveAllowedOrigin,
    });
  }
  registerCadetProtocol(path.join(app.getPath("userData"), BUNDLES_DIR_NAME));
  installPermissionHandler(resolveAllowedOrigin);
  installCsp();
  if (app.isPackaged) {
    writeCliLocator();
    void provisionCliForWrapper().catch((err: unknown) => {
      log.error("[app] startup CLI provisioning failed:", err);
    });
  }
  // Every main-process feature, installed explicitly in the glob's
  // sorted order — the list the old auto-discovery hid. The hotkey
  // settings and auto-update installs the features used to carry live in
  // startApp now (the three shells wired them identically).
  installAuth();
  installAuxiliaryWindows();
  installBundles();
  installCommands();
  installDeepLinks();
  installDiagnostics();
  installDictation();
  installDownloads();
  installFileOpen();
  installHostProxy();
  installMainWindow();
  installNotifications();
  installPermissions();
  installPresence();
  installShare();
  installVoiceModeChord();
  installWindowAttention();
});

app.on("second-instance", () => {
  ensureVisible();
});

app.on("window-all-closed", () => {
  // Keep the notification-area tray available to reopen the window.
});

app.on("web-contents-created", (_event, contents) => {
  // Feature modules each attach cleanup listeners; lift the default cap of
  // 10 so they don't trip MaxListenersExceededWarning.
  contents.setMaxListeners(20);
  installWebContentsSecurity(contents, {
    cookies: () => session.defaultSession.cookies,
    logger: log,
    openExternal: (url) => shell.openExternal(url),
  });
});
