import "./env-seed";

import { app, net, protocol, session, shell } from "electron";
import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  BUNDLES_DIR_NAME,
  CADET_PROTOCOL,
} from "@mycadet/electron-desktop/bundle-platform";
import { getVersionInfo } from "@mycadet/electron-desktop/about";
import { installCsp } from "@mycadet/electron-desktop/csp";
import { getDeviceId } from "@mycadet/electron-desktop/device-id";
import {
  forwardGatewayRequest,
} from "@mycadet/electron-desktop/gateway-forward";
import { installGatewayRequestGuard } from "@mycadet/electron-desktop/gateway-request-guard";
import { installPermissionHandler } from "@mycadet/electron-desktop/permissions";
import { forwardCloudRequest } from "@mycadet/electron-desktop/cloud-forward";
import { registerCadetProtocol } from "@mycadet/electron-desktop/cadet-protocol";
import { planAppProtocolAssetRequest } from "@mycadet/electron-utils/app-protocol";
import { resolveLocalConfigFromEnv } from "@mycadet/local-mode";

import {
  APP_HOST,
  APP_PROTOCOL,
  WINDOWS_RELEASE_INFO,
  usesAppProtocolRenderer,
} from "./app-config";
import { resolveAllowedOrigin } from "./app-origin.client";
import {
  provisionCliForCurrentUser,
  resolveCliPathFlowOptions,
} from "./cli-path-flow";
import { installMainFeatures } from "./features";
import { handleSync } from "./ipc.client";
import log from "./logger";
import { ensureVisible } from "./main-window";
import { installWebContentsSecurity } from "./windows.client";

/**
 * Windows shell for the Cadet: a hardened BrowserWindow loading
 * the clients/web renderer (Vite dev server in dev, `app://` static serving
 * of `resources/cli-runtime/web-dist` in packaged builds). Every desktop
 * capability is a module under `./features/`, composed through the capability
 * registry once the app is ready; `docs/parity-matrix.md` maps them to their
 * macOS counterparts.
 */

// Dev-only: override the package `name` (`@mycadet/windows`) so
// `app.getPath("userData")` resolves to its own directory, cleanly separate
// from other Cadet installs (including the macOS Electron shell when
// developing this package on a Mac). Packaged builds get a real
// `productName` from electron-builder. Must run before `userData` is first
// read.
if (!app.isPackaged) {
  app.setName("Cadet Electron Windows");
}

// Toasts and taskbar grouping key off the AppUserModelID. Packaged builds
// get it from the installer shortcut; dev would otherwise show "electron.app".
app.setAppUserModelId(WINDOWS_RELEASE_INFO.appUserModelId);

// Packaged builds all share the same package.json `name`, so Electron
// resolves `app.getPath("userData")` to the same directory for every
// environment. Append an environment suffix for non-production builds so
// dev/staging/production installs can run side-by-side; production keeps the
// original path for backwards compatibility.
const releaseChannel = WINDOWS_RELEASE_INFO.releaseChannel;
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

// Serve clients/web/dist/ as static files via `app://mycadet.ai/...`. Route-like
// paths (no file extension, or `.html`) fall back to index.html so React
// Router can handle client-side routes on reload; requests for missing
// static assets return 404 so a stale or partial deploy surfaces as a load
// error rather than silently serving HTML with a wrong Content-Type.
// `clients/web/vite.config.ts` sets `base: "/assistant/"`, so the built HTML
// emits asset URLs like `/assistant/assets/index.js` while the files on disk
// live directly under `rendererRoot`; the mount prefix is stripped before
// path resolution.
//
const RENDERER_MOUNT = "/assistant";

const resolveRendererRoot = (): string => {
  if (app.isPackaged) {
    // The renderer bundle ships once, inside the CLI runtime (see
    // scripts/package-runtime.ts); the installed copy under userData is a
    // clone of this directory.
    return path.join(process.resourcesPath, "cli-runtime", "web-dist");
  }
  // Dev source tree: clients/web/dist. Requires `bun run build` in clients/web/.
  const repoRoot = path.resolve(app.getAppPath(), "..", "..");
  return path.join(repoRoot, "clients", "web", "dist");
};

const registerAppProtocol = (): void => {
  const rendererRoot = resolveRendererRoot();
  const indexHtml = path.join(rendererRoot, "index.html");

  protocol.handle(APP_PROTOCOL, async (request) => {
    // Forward the id-keyed gateway proxy to its lockfile-resolved target
    // (mirrors the Vite dev-server proxy).
    const proxied = await forwardGatewayRequest(request, net.fetch);
    if (proxied) {
      return proxied;
    }

    // `/v1/*`, `/_allauth/*`, `/accounts/*` forward to the
    // cloud so managed mode and desktop replay ingest work.
    const cloudProxied = await forwardCloudRequest({
      request,
      cloudBase: resolvedConfig.cloudUrl,
      fetcher: net.fetch,
      allowedOrigin: resolveAllowedOrigin(),
      log,
    });
    if (cloudProxied) {
      return cloudProxied;
    }

    const asset = await planAppProtocolAssetRequest({
      rendererRoot,
      indexHtml,
      requestUrl: request.url,
      mountPrefix: RENDERER_MOUNT,
      allowedOrigin: { protocol: `${APP_PROTOCOL}:`, host: APP_HOST },
    });
    if (asset.kind === "forbidden") {
      return new Response("Forbidden", { status: 403 });
    }
    if (asset.kind === "fetch") {
      return net.fetch(pathToFileURL(asset.path).toString());
    }
    return new Response("Not Found", { status: 404 });
  });
};

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

app
  .whenReady()
  .then(() => {
    log.info("[app] ready");
    if (usesAppProtocolRenderer(app.isPackaged)) {
      registerAppProtocol();
      installGatewayRequestGuard({
        appOrigin: { protocol: `${APP_PROTOCOL}:`, host: APP_HOST },
        resolveAllowedOrigin,
      });
    }
    registerCadetProtocol(
      path.join(app.getPath("userData"), BUNDLES_DIR_NAME),
    );
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
    installMainFeatures();
  })
  .catch((err: unknown) => {
    log.error("[app] whenReady setup failed:", err);
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
