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
import { installMainFeatures } from "./features";
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
  installMainFeatures();
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
