import "./env-seed";
import { app, net, Notification, protocol, session, shell } from "electron";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { installCsp } from "@mycadet/electron-desktop/csp";
import { installCommandPaletteWindow } from "@mycadet/electron-desktop/command-palette-window";
import { getDeviceId } from "@mycadet/electron-desktop/device-id";
import { installDictationOverlay } from "@mycadet/electron-desktop/dictation-overlay-window";
import {
  forwardGatewayRequest,
  forwardPairedGatewayRequest,
} from "@mycadet/electron-desktop/gateway-forward";
import { installPermissionHandler } from "@mycadet/electron-desktop/permissions";
import { installPairedGatewayRequestGuard } from "@mycadet/electron-desktop/paired-gateway-request-guard";
import { forwardCloudRequest } from "@mycadet/electron-desktop/cloud-forward";
import { installPopoutWindows } from "@mycadet/electron-desktop/popout-window";
import { installQuickInput } from "@mycadet/electron-desktop/quick-input-window";
import { planAppProtocolAssetRequest } from "@mycadet/electron-utils/app-protocol";
import {
  getLockfileData,
  getLoopbackGatewayPort,
  pairedGatewayTargetsFromLockfile,
  readAllowedGatewayPorts,
  readPairedGatewayTargets,
  resolveLocalConfigFromEnv,
  resolveLockfilePaths,
} from "@mycadet/local-mode";

import { getVersionInfo, installAbout, openAboutWindow } from "./about.client";
import { installAutoUpdate } from "./auto-update.client";
import {
  BUNDLES_DIR_NAME,
  CADET_PROTOCOL,
} from "@mycadet/electron-desktop/bundle-platform";
import { registerCadetProtocol } from "@mycadet/electron-desktop/cadet-protocol";
import { APP_HOST, APP_PROTOCOL } from "./app-config";
import { resolveAllowedOrigin } from "./app-origin";
import { writeCliLocator } from "./cli-installer";
import { provisionCliForWrapper } from "./cli-path-installer";
import { handle, handleSync, on } from "./ipc";
import { hasPendingDeepLinks, installDeepLinks } from "./deep-links.client";
import { handleBundleFile, installMacBundleWorkflow } from "./bundles";
import {
  handleFileOpenArgv,
  hasPendingFiles,
  installFileOpen,
  onFileOpen,
} from "./file-open.client";
import { installAvatarIpc } from "@mycadet/electron-desktop/avatar";
import { installConnectivityProbe } from "@mycadet/electron-desktop/connectivity-probe";
import { installDownloads } from "@mycadet/electron-desktop/downloads";
import { installIdentityIpc } from "@mycadet/electron-desktop/identity";
import {
  configureNotifications,
  installNotifications,
} from "@mycadet/electron-desktop/notifications";
import { installPowerEvents } from "@mycadet/electron-desktop/power-events";
import { configurePresenceRuntime } from "@mycadet/electron-desktop/presence-runtime";
import {
  installConnectivityIpc,
  installStatusIpc,
} from "@mycadet/electron-desktop/status";
import "./auxiliary-windows.client";
import { installDock } from "./dock";
import { installShare } from "./share";
import { installWindowAttentionFeature } from "./window-attention";
import { installEscapeMonitor, setDictationRecording } from "./escape-monitor";
import {
  installDiagnosticsIpc,
  installFeatureFlagsIpc,
  installFeedbackIpc,
} from "./desktop-diagnostics";
import { installGlobalShortcuts } from "./global-shortcuts.client";
import { installHotkeyHelper } from "./hotkey-helper";
import { installHotkeysIpc } from "./hotkeys.client";
import { installImageContextMenu } from "@mycadet/electron-desktop/image-context-menu";
import { installTextContextMenu } from "@mycadet/electron-desktop/text-context-menu";
import {
  getPairedGuardianAccessToken,
  installLocalMode,
  resolveCliInvocation,
} from "./local-mode.client";
import { installLoginItem, installLoginItemIpc } from "./login-item.client";
import {
  getWatchedLockfileSnapshot,
  installLockfileWatcher,
} from "./lockfile-watcher.client";
import { installHostProxyBridge } from "./host-proxy-adapter";
import log from "./logger";
import {
  ensureVisible as ensureMainWindowVisible,
  installMainWindow,
  toggleVisibility as toggleMainWindowVisibility,
} from "./main-window";
import { installApplicationMenu, refreshCliPathMenuState } from "./menu";
import {
  promptToRelocateIfStranded,
  relocateToApplicationsFolder,
} from "./move-to-applications";
import { markRelocationSkipped } from "./install-location";
import { installNativeAuth } from "./native-auth.client";
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
  syncCompanionSurface,
} from "./companion-window";
import { installTextInsertionIpc } from "./textInsertion";
import { installTray } from "./tray.client";
import { installWebContentsSecurity } from "./windows";

// Dev-only: override the workspace `name` (`@mycadet/macos`) so the
// menu bar's first submenu reads "Cadet Electron", and — more
// importantly — so `app.getPath("userData")` resolves to
// `~/Library/Application Support/Cadet Electron/`, cleanly separate
// from the other app installs (current and legacy) the developer may
// also be running.
//
// Caveat: `app.setName()` does NOT change the Dock / Cmd-Tab label —
// those come from the running binary's `CFBundleName`. In dev the binary
// is the `node_modules/electron/dist/Electron.app` binary, whose
// `CFBundleName` is stamped to "Cadet Local" by
// `scripts/prepare-electron-dev-app.ts` (which also busts the macOS Dock
// display-name cache so the relabel
// actually surfaces instead of the stale stock "Electron"). The userData
// split is what prevents collision with Swift installs. Packaged builds
// get a real `productName` from electron-builder, which writes
// `CFBundleName`, so Dock / Cmd-Tab pick up the real name there too. The
// per-assistant name (e.g. "Aria") can't ride the Dock tile — it isn't
// known at launch and `CFBundleName` is read once — so it drives the
// window title, the menu-bar tray, and the About panel instead (see
// `./identity`).
//
// Gated on `!app.isPackaged` so a packaged build keeps its
// electron-builder-derived `CFBundleName` instead of being overridden
// at runtime. Must run before `app.getPath("userData")` is first read;
// the electron-store instance in `./settings` is constructed lazily on
// first IPC call, so this timing holds as long as `app.setName` runs
// before `app.whenReady`.
if (!app.isPackaged) {
  app.setName("Cadet Electron");
}
const isDev = !app.isPackaged;

// Dev-only: skip the real macOS Keychain for Chromium's `os_crypt` /
// Electron `safeStorage`. Without this, the first `safeStorage` call —
// e.g. persisting the session token after sign-in via
// `./session-token-store.client` makes Chromium prompt for the login
// keychain password ("Cadet Electron Safe Storage"). Denying that
// prompt surfaces as `keychain_password_mac.mm ... userCanceledErr
// (-128)` and silently drops token persistence. `--use-mock-keychain`
// routes os_crypt to an in-process mock backend: `safeStorage` stays
// available and encrypt/decrypt still work (so the token persists
// across dev restarts), but nothing ever touches the real keychain, so
// there is no prompt. Dev-encrypted blobs are not readable by a real
// keychain build, which is fine for local dev — and a `session.enc`
// left over from a previous real-keychain run just fails to decrypt and
// falls back to signed-out (see `getSessionToken`), self-healing on the
// next sign-in. Must be appended before `app` is ready; this module
// runs synchronously at startup, well before `app.whenReady`. Gated on
// dev so packaged builds keep real keychain encryption at rest.
if (isDev) {
  app.commandLine.appendSwitch("use-mock-keychain");
}

// Packaged builds all share the same package.json `name` (`@mycadet/macos`),
// so Electron resolves `app.getPath("userData")` to the same directory for
// every environment. This causes `requestSingleInstanceLock()` collisions
// when multiple environment builds (dev, staging, production) run side-by-side.
// Append an environment suffix for non-production builds; production keeps the
// original path for backwards compatibility.
declare const __CADET_ENVIRONMENT__: string;
if (app.isPackaged) {
  const env =
    typeof __CADET_ENVIRONMENT__ === "string"
      ? __CADET_ENVIRONMENT__
      : "production";
  if (env !== "production") {
    const base = app.getPath("userData");
    app.setPath("userData", `${base}-${env}`);
  }
}

// Single-instance lock: relaunches focus the existing window instead of
// spawning a parallel main process. The second-instance handler fires on the
// instance that holds the lock (the primary).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
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

// Deep-link plumbing — register at module top-level so the
// `will-finish-launching` subscription captures URLs delivered AT
// launch (the OS opens the app via a `cadet://` click → `open-url`
// can fire before `whenReady`). Registering in `whenReady` misses
// the launching URL — the #1 deep-link bug in Electron apps.
installDeepLinks();
installFileOpen();

// Serve the app/web split over `app://mycadet.ai/...`:
//
// - The app shell (`@mycadet/app` standalone build, root-based) is the MAIN
//   window's renderer. Its paths resolve against `appDistRoot` with no mount
//   prefix; extension-less misses fall back to the app dist's index.html so
//   the shell's client routes survive reload / deep-link.
// - The `/assistant` mount serves the web bundle (`clients/web`, base
//   `/assistant/`) for the windows that still render web routes (about,
//   command palette, companion, popouts) and as the local-assistant iframe
//   content the app shell frames. The package no longer ships a web dist —
//   the web UI is iframed from the assistant's own version — so packaged
//   requests under the mount 404 until those windows move to the
//   assistant-served bundle (dev keeps the source-tree dist). Route-like web
//   paths fall back to the web dist's index.html; missing web assets 404 so a
//   stale or partial deploy surfaces as a load error rather than silently
//   serving HTML with a wrong Content-Type.
//
// Reference: https://www.electronjs.org/docs/latest/api/protocol#protocolhandlescheme-handler
// `clients/web/vite.config.ts` sets `base: "/assistant/"`, so the built HTML
// emits asset URLs like `/assistant/assets/index.js`. The web renderer files
// on disk live directly under `webDistRoot`, NOT under `webDistRoot/assistant/`.
// The mount is passed separately so the protocol handler strips it before
// path resolution.
const resolveAppDistRoot = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app-dist");
  }
  // Dev source tree: clients/app/dist/standalone — requires `bun run build`
  // in clients/app/ (the standalone target's outDir).
  const repoRoot = path.resolve(app.getAppPath(), "..", "..");
  return path.join(repoRoot, "clients", "app", "dist", "standalone");
};

const resolveWebDistRoot = (): string => {
  // Packaged builds stopped shipping web-dist (the web bundle is iframed from
  // the assistant's version); dev reads the source-tree build.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "web-dist");
  }
  // Dev source tree: clients/web/dist — requires `bun run build` in clients/web/.
  const repoRoot = path.resolve(app.getAppPath(), "..", "..");
  return path.join(repoRoot, "clients", "web", "dist");
};

const registerAppProtocol = (): void => {
  const appDistRoot = resolveAppDistRoot();
  const appIndexHtml = path.join(appDistRoot, "index.html");
  const webDistRoot = resolveWebDistRoot();
  const webIndexHtml = path.join(webDistRoot, "index.html");
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
  const { cloudUrl } = resolveLocalConfigFromEnv(process.env);

  // Same-origin `/v1/*` rides the active local assistant's gateway — the
  // same contract the CLI edge implements by proxying `/v1` there — while
  // the platform's login surfaces always ride the cloud (the forward
  // resolves that by path). The env-resolved seed covers the no-lockfile
  // window.
  const getActiveGatewayBase = (): string | undefined => {
    const read = getLockfileData(lockfilePaths);
    if (!read.ok) {
      return undefined;
    }
    const entry = read.data.activeAssistant
      ? read.data.assistants.find(
          (a) => a.assistantId === read.data.activeAssistant,
        )
      : read.data.assistants[0];
    if (!entry || entry.cloud === "paired") {
      return undefined;
    }
    const port = getLoopbackGatewayPort(entry);
    return port ? `http://127.0.0.1:${port}` : undefined;
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
    if (proxied) return proxied;

    // Paired remote gateways ride the same-origin path too, via
    // `/assistant/__gateway-paired/{assistantId}/*`: the packaged app's CSP
    // pins `connect-src` to Cadet origins, so the renderer cannot reach a
    // paired gateway directly. The WebRequest guard admits only trusted app
    // frames, and the lockfile's paired entries allowlist the remote targets.
    const pairedProxied = await forwardPairedGatewayRequest(
      request,
      getPairedGatewayTargets,
      getPairedGuardianAccessToken,
      net.fetch,
    );
    if (pairedProxied) {
      return pairedProxied;
    }

    // Cloud API and authentication routes forward through the shared
    // cloud forward: the login surfaces ride the cloud, same-origin
    // `/v1/*` rides the active local assistant's gateway.
    const cloudProxied = await forwardCloudRequest({
      request,
      cloudBase: cloudUrl,
      gatewayBase: getActiveGatewayBase(),
      fetcher: net.fetch,
      allowedOrigin: resolveAllowedOrigin(),
      log,
    });
    if (cloudProxied) return cloudProxied;

    // The `/assistant` mount serves the web bundle (auxiliary windows and
    // the local-assistant iframe); every other path is the app shell.
    const isWebMount = new URL(request.url).pathname.startsWith("/assistant");
    const asset = await planAppProtocolAssetRequest({
      rendererRoot: isWebMount ? webDistRoot : appDistRoot,
      indexHtml: isWebMount ? webIndexHtml : appIndexHtml,
      requestUrl: request.url,
      mountPrefix: isWebMount ? "/assistant" : undefined,
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

const resolvedConfig = resolveLocalConfigFromEnv(process.env);
handleSync("cadet:config:get", () => ({
    cloudUrl: resolvedConfig.cloudUrl,
  deviceId: getDeviceId(),
  version: getVersionInfo().version,
}));

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app
  .whenReady()
  .then(async () => {
    // The instance that lost the single-instance lock is already quitting.
    // `app.quit()` requests a shutdown rather than halting the module, and a
    // `ready` that is already queued still fires, so the losing instance gates
    // its own setup here. Electron's documented single-instance example puts
    // every `whenReady` side effect behind this same branch.
    // https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata
    if (!gotSingleInstanceLock) {
      return;
    }

    configurePresenceRuntime({ ipc: { handle, on }, logger: log });

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

    // Dev packs the renderer dists (see `bun run dev`) and serves them
    // through the same `app://mycadet.ai` origin as packaged builds, so
    // the handler and the paired-gateway guard are unconditional.
    registerAppProtocol();
    installPairedGatewayRequestGuard({
      appOrigin: { protocol: `${APP_PROTOCOL}:`, host: APP_HOST },
      resolveAllowedOrigin,
    });
    registerCadetProtocol(path.join(app.getPath("userData"), BUNDLES_DIR_NAME));
    installMacBundleWorkflow();
    onFileOpen(handleBundleFile);
    installPermissionHandler(resolveAllowedOrigin);
    installCsp();
    installHotkeysIpc();
    installFeatureFlagsIpc();
    installDiagnosticsIpc();
    installLocalMode();
    // Refresh the PATH-wrapper locator every launch so app moves and
    // version bumps self-heal even if no CLI invocation happens this session.
    if (app.isPackaged) {
      writeCliLocator();
      // Wrapper users also get the pinned CLI provisioned eagerly so a
      // version bump rewrites the locator now (and prunes old versions)
      // rather than after the next in-app CLI action.
      void provisionCliForWrapper()
        .then((provisioned) =>
          provisioned ? refreshCliPathMenuState() : undefined,
        )
        .catch((err: unknown) => {
          log.error("[app] startup CLI provisioning failed:", err);
        });
    }
    installLoginItem();
    installLoginItemIpc();
    installHotkeyHelper();
    installCompanionPermissionGuide(installPermissionsService());
    // Register the identity (assistant name) channel before About, the Tray,
    // and the main window install so their initial render reflects any name
    // the renderer publishes during bootstrap.
    installIdentityIpc();
    installAbout();
    installAutoUpdate();
    installFeedbackIpc();
    installTextInsertionIpc();
    installCommandPaletteWindow();
    installApplicationMenu();
    installQuickInput();
    installDictationOverlay({ onRecordingLifecycle: setDictationRecording });
    installCompanionWindow();
    installPopoutWindows();
    installGlobalShortcuts();
    // Register the avatar channel before the Dock and Tray install so their
    // initial render reflects any avatar the renderer publishes during
    // bootstrap rather than briefly showing the bundled fallback mark.
    installAvatarIpc();
    installDock();
    installShare();
    // Files renderer downloads into ~/Downloads instead of prompting a Save
    // panel. Distinct from `installShare`, which is the "send elsewhere" intent.
    installDownloads({ handle });
    installPowerEvents();
    // The addon takes the notifications the assistant avatar can ride on only
    // when it says it can have them: an unbundled run loads it fine and then
    // reports unsupported, because UNUserNotificationCenter raises there.
    // `isSupported` ships with `create` rather than being left to the shared
    // module's default; see the delegate rule in README.md.
    const nativeNotifications = isNotifierSupported()
      ? createNativeNotificationFactory()
      : null;
    configureNotifications({
      ipc: { handle },
      ensureVisible: ensureMainWindowVisible,
      logger: log,
      ...(nativeNotifications ?? {}),
    });
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
    // Register the status channel before the tray installs so the tray's
    // initial render reflects any status the renderer publishes during
    // bootstrap rather than briefly showing the default idle dot.
    installStatusIpc();
    installEscapeMonitor();
    const lockfilePaths = resolveLockfilePaths(process.env);
    const runProbe = installConnectivityProbe(lockfilePaths);
    installConnectivityIpc(runProbe);
    // Start watching the lockfile before the tray installs so the assistant
    // switcher submenu has data on its first right-click.
    const teardownLockfileWatcher = installLockfileWatcher();
    app.on("before-quit", teardownLockfileWatcher);
    const teardownHostProxy = installHostProxyBridge(resolveCliInvocation);
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
  })
  .catch((err: unknown) => {
    log.error("[app] whenReady setup failed:", err);
  });

app.on("second-instance", (_event, argv) => {
  // Behavior change vs prior code path: previously a second-instance
  // launch was a no-op when the main window had been destroyed. Now
  // we recreate so the user always sees a window in response to
  // re-launching the app.
  ensureMainWindowVisible();
  handleFileOpenArgv(argv);
});

app.on("web-contents-created", (_event, contents) => {
  // Electron internals + our own cleanup listeners (deep-links, power-events)
  // exceed the default 10-listener cap per WebContents, triggering a spurious
  // MaxListenersExceededWarning. Bump the limit to silence it.
  contents.setMaxListeners(20);

  // Right-click on an image → native "Copy Image" menu. Wired here so every
  // surface (main window, popouts, command palette, child popups) gets it.
  installImageContextMenu(contents);
  installTextContextMenu(contents);

  installWebContentsSecurity(contents, {
    cookies: () => session.defaultSession.cookies,
    logger: log,
    openExternal: (url) => shell.openExternal(url),
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
