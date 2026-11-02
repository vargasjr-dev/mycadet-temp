import "./env-seed";

import { app, protocol, session, shell } from "electron";
import path from "node:path";

import {
  BUNDLES_DIR_NAME,
  CADET_PROTOCOL,
} from "@mycadet/electron-desktop/bundle-platform";
import { getVersionInfo } from "@mycadet/electron-desktop/about";
import { installCsp } from "@mycadet/electron-desktop/csp";
import { getDeviceId } from "@mycadet/electron-desktop/device-id";
import { registerAppProtocol } from "@mycadet/electron-desktop/app-protocol-forward";
import { installGatewayRequestGuard } from "@mycadet/electron-desktop/gateway-request-guard";
import { installPermissionHandler } from "@mycadet/electron-desktop/permissions";
import { registerCadetProtocol } from "@mycadet/electron-desktop/cadet-protocol";
import { runWhenReady } from "@mycadet/electron-desktop/app-lifecycle";
import { resolveLocalConfigFromEnv } from "@mycadet/local-mode";

import {
  APP_HOST,
  APP_PROTOCOL,
  LINUX_RELEASE_INFO,
  usesAppProtocolRenderer,
} from "./app-config";
import { resolveAllowedOrigin } from "./app-origin.client";
import { writeCliLocator } from "./cli-installer";
import { provisionCliForWrapper } from "./cli-path-installer";
import { installMainFeatures } from "./features";
import { handleSync } from "./ipc.client";
import log from "./logger";
import { ensureVisible } from "./main-window";
import { installWebContentsSecurity } from "./windows.client";

/**
 * Linux shell for the Cadet Assistant: a hardened BrowserWindow loading
 * the clients/web renderer (Vite dev server in dev, `app://` static serving
 * of `resources/web-dist` in packaged builds). Every desktop capability is a
 * module under `./features/`, composed through the capability registry once
 * the app is ready.
 */

// Dev-only: override the package `name` (`@mycadet/linux`) so
// `app.getPath("userData")` resolves to its own directory, cleanly separate
// from other Cadet installs. Packaged builds get a real `productName` from
// electron-builder. Must run before `userData` is first read.
if (!app.isPackaged) {
  app.setName("Cadet Electron Linux");
}

// Packaged builds all share the same package.json `name`, so Electron
// resolves `app.getPath("userData")` to the same directory for every
// environment. Append an environment suffix for non-production builds so
// dev/staging/production installs can run side-by-side; production keeps the
// original path for backwards compatibility.
const releaseChannel = LINUX_RELEASE_INFO.releaseChannel;
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

// Synchronous config snapshot exposed to the renderer as `window.__CADET_CONFIG__`.
const resolvedConfig = resolveLocalConfigFromEnv();
handleSync("cadet:config:get", () => ({
  baseUrl: `${APP_PROTOCOL}://${APP_HOST}`,
  deviceId: getDeviceId(),
  version: getVersionInfo().version,
}));

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

runWhenReady(log, () => {
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
