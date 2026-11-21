import "./env-seed";

import { app, protocol, session, shell } from "electron";
import path from "node:path";

import {
  BUNDLES_DIR_NAME,
  CADET_PROTOCOL,
} from "@mycadet/electron-desktop/bundle-platform";
import { getVersionInfo } from "@mycadet/electron-desktop/about";
import {
  registerAppProtocol,
  installCsp,
  getDeviceId,
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
import { log } from "@mycadet/electron-desktop";
import { handleSync } from "@mycadet/electron-desktop/ipc";
import {
  ensureVisible,
  installClassicShellFeatures,
  provisionCliForCurrentUser,
  resolveCliPathFlowOptions,
} from "@mycadet/electron-desktop/classic-shell";
import { installWebContentsSecurity } from "@mycadet/electron-desktop";

// Toasts and taskbar grouping key off the AppUserModelID, which must match
// the installed shortcut's id — the builder config is the single source, so
// the build define is read here rather than round-tripped through a
// release-info module. macOS/Linux need no such call: their identity rides
// the OS bundle metadata (Info.plist / the .desktop file).
declare const __CADET_APP_USER_MODEL_ID__: string;
app.setAppUserModelId(
  typeof __CADET_APP_USER_MODEL_ID__ === "string"
    ? __CADET_APP_USER_MODEL_ID__
    : "ai.mycadet.electron",
);

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

handleSync("cadet:config:get", () => ({
  baseUrl: `${APP_PROTOCOL}://${APP_HOST}`,
  deviceId: getDeviceId(),
  version: getVersionInfo().version,
}));

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
  if (app.isPackaged && process.platform === "win32") {
    try {
      const result = provisionCliForCurrentUser(resolveCliPathFlowOptions());
      if (["foreign", "shadowed"].includes(result.launcherState)) {
        log.warn(`[cli] Windows launcher is ${result.launcherState}`);
      }
    } catch (error) {
      log.error("[cli] Failed to provision the Windows CLI:", error);
    }
  }
  // Every main-process feature, in the glob-sorted order the old
  // auto-discovery hid — one ordered list in the package now, since both
  // classic-desktop shells ran it identically. The universal installs
  // (hotkey settings, auto-update) ran earlier, in startApp.
  installClassicShellFeatures();
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
