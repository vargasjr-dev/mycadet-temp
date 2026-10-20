import "./env-seed";

import { app, net, protocol, session, shell } from "electron";
import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  BUNDLES_DIR_NAME,
  CADET_PROTOCOL,
} from "@mycadet/electron-desktop/bundle-platform";
import { installCsp } from "@mycadet/electron-desktop/csp";
import { getDeviceId } from "@mycadet/electron-desktop/device-id";
import {
  forwardGatewayRequest,
  forwardPairedGatewayRequest,
} from "@mycadet/electron-desktop/gateway-forward";
import { getPairedGuardianAccessToken } from "@mycadet/electron-desktop/local-mode";
import { getWatchedLockfileSnapshot } from "@mycadet/electron-desktop/lockfile-watcher";
import { installPairedGatewayRequestGuard } from "@mycadet/electron-desktop/paired-gateway-request-guard";
import { installPermissionHandler } from "@mycadet/electron-desktop/permissions";
import { forwardCloudRequest } from "@mycadet/electron-desktop/cloud-forward";
import { registerCadetProtocol } from "@mycadet/electron-desktop/cadet-protocol";
import { planAppProtocolAssetRequest } from "@mycadet/electron-utils/app-protocol";
import {
  pairedGatewayTargetsFromLockfile,
  readAllowedGatewayPorts,
  readPairedGatewayTargets,
  resolveLocalConfigFromEnv,
  resolveLockfilePaths,
} from "@mycadet/local-mode";

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
    return path.join(process.resourcesPath, "web-dist");
  }
  // Dev source tree: clients/web/dist. Requires `bun run build` in clients/web/.
  const repoRoot = path.resolve(app.getAppPath(), "..", "..");
  return path.join(repoRoot, "clients", "web", "dist");
};

const registerAppProtocol = (): void => {
  const rendererRoot = resolveRendererRoot();
  const indexHtml = path.join(rendererRoot, "index.html");
  const lockfilePaths = resolveLockfilePaths(process.env);
  const getAllowedGatewayPorts = (): Set<number> =>
    readAllowedGatewayPorts(lockfilePaths);
  // Prefer the watcher's in-memory snapshot so paired requests never read
  // disk; the direct read covers only the window before the watcher installs.
  const getPairedGatewayTargets = (): Map<string, string> => {
    const watched = getWatchedLockfileSnapshot();
    return watched
      ? pairedGatewayTargetsFromLockfile(watched)
      : readPairedGatewayTargets(lockfilePaths);
  };

  protocol.handle(APP_PROTOCOL, async (request) => {
    // The renderer addresses local gateways at the same `app://` origin via
    // `/assistant/__gateway/{port}/*`. Forward those to loopback here so the
    // secure renderer never touches an insecure `http://127.0.0.1` origin
    // directly; the lockfile allowlist is the security boundary. Mirrors the
    // Vite dev-server proxy (`clients/web/vite-plugin-local-mode.ts`).
    const proxied = await forwardGatewayRequest(
      request,
      getAllowedGatewayPorts,
      net.fetch,
    );
    if (proxied) {
      return proxied;
    }

    // Paired remote gateways ride the same-origin path too, via
    // `/assistant/__gateway-paired/{assistantId}/*`; the WebRequest guard
    // admits only trusted app frames, and the lockfile's paired entries
    // allowlist the remote targets.
    const pairedProxied = await forwardPairedGatewayRequest(
      request,
      getPairedGatewayTargets,
      getPairedGuardianAccessToken,
      net.fetch,
    );
    if (pairedProxied) {
      return pairedProxied;
    }

    // `/v1/*`, `/_allauth/*`, `/accounts/*` forward to the
    // cloud so managed mode and desktop replay ingest work.
    const cloudProxied = await forwardCloudRequest({
      request,
      cloudBase: resolvedConfig.cloudUrl,
      fetcher: net.fetch,
      allowedOrigin: resolveAllowedOrigin(),
      log: log.error,
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

// Synchronous config snapshot the preload reads at startup and exposes to the
// renderer as `window.__CADET_CONFIG__`.
const resolvedConfig = resolveLocalConfigFromEnv(process.env);
handleSync("cadet:config:get", () => ({
    cloudUrl: resolvedConfig.cloudUrl,
  deviceId: getDeviceId(),
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
      installPairedGatewayRequestGuard({
        appOrigin: { protocol: `${APP_PROTOCOL}:`, host: APP_HOST },
        resolveAllowedOrigin,
      });
    }
    registerCadetProtocol(
      path.join(app.getPath("userData"), BUNDLES_DIR_NAME),
    );
    installPermissionHandler(resolveAllowedOrigin);
    installCsp();
    if (app.isPackaged) {
      writeCliLocator();
      void provisionCliForWrapper().catch((err: unknown) => {
        log.error("[app] startup CLI provisioning failed:", err);
      });
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
