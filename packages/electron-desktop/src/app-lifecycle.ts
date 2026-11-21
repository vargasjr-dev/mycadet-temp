import "./env-seed";

import { app, protocol, session, shell } from "electron";
import path from "node:path";

import { resolveEnvironmentName } from "@mycadet/shared";

import { getAppName } from "./app-name";
import {
  APP_HOST,
  APP_PROTOCOL,
  APP_RENDERER_BASE_PROD,
  getRendererBase,
  usesAppProtocolRenderer,
} from "./app-config";
import { registerAppProtocol } from "./app-protocol-forward";
import { BUNDLES_DIR_NAME, CADET_PROTOCOL } from "./bundle-platform";
import { registerCadetProtocol } from "./cadet-protocol";
import { installGatewayRequestGuard } from "./gateway-request-guard";
import { installPermissionHandler } from "./permissions";
import { installCsp } from "./csp";
import { resolveAllowedOrigin } from "./app-origin";
import { installWebContentsSecurity } from "./windows";
import { configureDeepLinks, installDeepLinks } from "./deep-links";
import {
  configureFileOpen,
  handleFileOpenArgv,
  installFileOpen,
} from "./file-open";
import { installAvatarIpc } from "./avatar";
import { getName, installIdentityIpc, onNameChange } from "./identity";
import { installPowerEvents } from "./power-events";
import { installConnectivityIpc, installStatusIpc } from "./status";
import { installConnectivityProbe } from "./connectivity-probe";
import {
  configureNotifications,
  type NotificationCreateOptions,
  type NotificationLike,
} from "./notifications";
import { installUniversalFeatures } from "./universal-wiring";
import { installImageContextMenu } from "./image-context-menu";
import { installTextContextMenu } from "./text-context-menu";
import { installHotkeysIpc } from "./hotkeys";
import { configureAboutRuntime, installAbout } from "./about";
import { installDesktopMenu, refreshDesktopMenuCliPath } from "./menu";
import { installGlobalShortcuts } from "./global-shortcuts";
import { installQuickInput, toggleQuickInput } from "./quick-input-window";
import {
  current,
  dispatchToMain,
  ensureVisible,
  installMainWindow,
} from "./main-window";
import { installDownloads } from "./downloads";
import { installCommandPaletteWindow } from "./command-palette-window";
import { installPopoutWindows } from "./popout-window";
import { install as installWindowAttentionFeature } from "./features/window-attention";
import { install as installBundles } from "./features/bundles";
import { install as installDiagnostics } from "./features/diagnostics";
import { install as installAuth } from "./features/auth";
import { install as installAuxiliaryWindows } from "./features/auxiliary-windows";
import { install as installDictation } from "./features/dictation";
import { install as installHostProxy } from "./features/host-proxy";
import { install as installLoginItem } from "./features/login-item";
import { install as installPermissions } from "./features/permissions";
import { install as installTray } from "./features/tray";
import { install as installShare } from "./features/share";
import { install as installVoiceModeChord } from "./features/voice-mode-chord";
import {
  createHelperToastFactory,
  resolveHelperToastBinaryPath,
} from "./helper-toast-factory";
import {
  provisionCliForCurrentUser,
  resolveCliPathFlowOptions,
} from "./win32-cli/cli-path-flow";
import { provisionCliForWrapper } from "./cli-path-installer";
import { writeCliLocator } from "./cli-installer";
import log from "./app-logger";

/**
 * The client's own pieces of the lifecycle — the seams that genuinely
 * differ per desktop: which window `ensureVisible` restores, how launch
 * argv arrive, whether the renderer rides `app://` in dev, the toast
 * factory notifications deliver through, and the client's own setup.
 */
export interface DesktopAppInputs {
  /**
   * The client's own setup, run once the universal surface is in place and
   * skipped entirely on the single-instance lock loser. The classic shells
   * pass nothing: the classic-desktop composition below is already theirs.
   */
  setup?: () => void | Promise<void>;
  /**
   * Bring the client's main window to front. Defaults to the shared
   * main-window module's — the macOS shell passes its own, its window
   * being its own creation.
   */
  ensureVisible?: () => void | Promise<void>;
  /**
   * The argv this client receives launches through. macOS reads `open-url`
   * events instead and passes `[]`; the classic shells pass `process.argv`.
   */
  initialArgv?: readonly string[];
  /**
   * Whether the renderer is served from `app://`. Defaults to the packaged
   * check the classic shells shipped; macOS packs its renderer dists for dev
   * too, so it passes `() => true`.
   */
  rendererUsesAppProtocol?: () => boolean;
  /**
   * The toast factory notifications deliver through. Absent, the shared
   * module's `electron.Notification` default delivers click-only toasts.
   */
  notifications?: {
    create?: (options: NotificationCreateOptions) => NotificationLike;
    isSupported?: () => boolean;
  };
  /**
   * Runs once at the head of the lifecycle — after this launch's files and
   * deep links are captured, before anything is wired. Returning true stops
   * the startup: the precheck has quit this process itself (the macOS
   * move-to-Applications relaunch).
   */
  precheck?: () => boolean | Promise<boolean>;
  /**
   * The shell's toast-helper identity: the supervised sidecar's executable
   * name, its dev-override env var, and the sidecar client name it registers
   * under. The package resolves the binary and builds the factory; absent a
   * helper binary, notifications fall back to the shared default.
   */
  helperToastExecutable?: string;
  helperToastOverrideEnvVar?: string;
  helperToastName?: string;
}

// In prod, register `app://` and `cadet://` as "standard" + "secure" schemes
// so that fetch, service workers, and same-origin policy treat them like
// https://. Must run before `whenReady`, which `startApp` awaits.
const registerPrivilegedSchemes = (): void => {
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
};

// Packaged builds all share the same package.json `name`, so Electron
// resolves `app.getPath("userData")` to the same directory for every
// environment. Append an environment suffix for non-production builds so
// dev/staging/production installs can run side-by-side; production keeps the
// original path for backwards compatibility.
const applyUserDataSuffix = (environmentName: string): void => {
  if (app.isPackaged && environmentName !== "production") {
    const base = app.getPath("userData");
    app.setPath("userData", `${base}-${environmentName}`);
  }
};

/**
 * The packaged CLI provisioning every shell shipped: the locator write plus
 * the eager provision, gated on packaged builds. The wrapper family
 * (macOS + Linux) rewrites the locator every launch so app moves and version
 * bumps self-heal; macOS also refreshes the menu's CLI rows. Windows runs the
 * launcher flow instead.
 */
const provisionPackagedCli = (): void => {
  if (!app.isPackaged) {
    return;
  }
  if (process.platform === "win32") {
    try {
      const result = provisionCliForCurrentUser(resolveCliPathFlowOptions());
      if (["foreign", "shadowed"].includes(result.launcherState)) {
        log.warn(`[cli] Windows launcher is ${result.launcherState}`);
      }
    } catch (error) {
      log.error("[cli] Failed to provision the Windows CLI:", error);
    }
    return;
  }
  writeCliLocator();
  void provisionCliForWrapper()
    .then((provisioned) =>
      process.platform === "darwin" && provisioned
        ? refreshDesktopMenuCliPath()
        : undefined,
    )
    .catch((err: unknown) => {
      log.error("[app] startup CLI provisioning failed:", err);
    });
};

/**
 * The app-lifecycle seam every desktop client shares. Owns the wiring that
 * is identical across the three shells:
 *
 * - before `whenReady`: the single-instance lock (the losing instance quits
 *   and skips its own setup — a queued `ready` still fires after
 *   `app.quit()`), the privileged scheme registration, the side-by-side
 *   userData suffix, and the deep-link / file-open launch capture (the
 *   `will-finish-launching` subscription must exist before `whenReady` or
 *   the launch URL the OS delivered is missed);
 * - on ready: the universal installs (hotkey settings provider, auto-update),
 *   the protocol stack (app protocol + gateway guard, the cadet bundle
 *   protocol, the permission handler, the CSP), the presence/identity slice
 *   (avatar, identity, power, status, connectivity — registered before any
 *   window or tray exists so their initial render reflects what the renderer
 *   publishes during bootstrap), and the notification runtime — these run for
 *   the lock loser too, whose process is already quitting;
 * - then, behind the lock gate: the universal app surface (the bundle flow,
 *   the command surface — hotkey catalog, About, the desktop menu, global
 *   shortcuts, the context menus — diagnostics, downloads, window attention,
 *   and the floating windows), the classic-desktop composition (Windows,
 *   Linux), the packaged CLI provisioning, and the client's own setup.
 */
export const startApp = async (
  inputs: DesktopAppInputs = {},
): Promise<void> => {
  // Single-instance lock: relaunches focus the existing window instead of
  // spawning a parallel main process. The second-instance handler fires on
  // the instance that holds the lock (the primary).
  // https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata
  const hasInstanceLock = app.requestSingleInstanceLock();
  if (!hasInstanceLock) {
    app.quit();
  }

  const ensureMainWindow = async (): Promise<void> => {
    await (inputs.ensureVisible ?? ensureVisible)();
  };

  // Re-launches focus the existing window instead of spawning a parallel
  // main process. A second-instance launch recreates the main window when it
  // was destroyed, so the user always sees a window in response.
  app.on("second-instance", () => {
    void ensureMainWindow();
  });

  applyUserDataSuffix(resolveEnvironmentName());
  registerPrivilegedSchemes();

  // Deep-link plumbing — registered before `whenReady` so the
  // `will-finish-launching` subscription captures URLs delivered AT
  // launch (the OS opens the app via a `cadet://` click → `open-url`
  // can fire before `whenReady`). Registering in `whenReady` misses
  // the launching URL — the #1 deep-link bug in Electron apps.
  configureDeepLinks({
    ensureVisible: ensureMainWindow,
    initialArgv: inputs.initialArgv ?? process.argv,
  });
  installDeepLinks();
  configureFileOpen({ ensureMainWindowVisible: ensureMainWindow });
  installFileOpen();
  // Cold-launch argv: files the OS handed the first instance before the
  // handlers existed. macOS reads `open-file` events instead, so its input
  // is empty and this is a no-op.
  handleFileOpenArgv(inputs.initialArgv ?? process.argv);

  // The client's precheck — the macOS move-to-Applications relaunch — runs
  // before anything is wired: it may quit this process, and a relaunch that
  // lands after windows and menus exist would tear them down mid-flight.
  if (hasInstanceLock && inputs.precheck && (await inputs.precheck())) {
    app.quit();
    return;
  }

  // Feature modules each attach cleanup listeners; lift the default cap of
  // 10 so they don't trip MaxListenersExceededWarning. The security wiring
  // and the context menus ride every WebContents the process ever creates
  // (main window, popouts, command palette, child popups), so they are
  // subscribed before any window exists.
  app.on("web-contents-created", (_event, contents) => {
    contents.setMaxListeners(20);
    installWebContentsSecurity(contents, {
      cookies: () => session.defaultSession.cookies,
      logger: log,
      openExternal: (url) => shell.openExternal(url),
    });
    installImageContextMenu(contents);
    installTextContextMenu(contents);
  });

  app.setName(getAppName());
  void app
    .whenReady()
    .then(async () => {
      log.info("[app] ready");
      installUniversalFeatures();

      // Dev on the classic shells serves the renderer from the dev server,
      // so only packaged builds ride the `app://` origin there; macOS packs
      // its renderer dists for dev too, so its handler and gateway guard
      // are unconditional.
      const rendererUsesAppProtocol =
        inputs.rendererUsesAppProtocol ??
        (() => usesAppProtocolRenderer(app.isPackaged));
      if (rendererUsesAppProtocol()) {
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

      // The identity channels register before any window, menu, or tray
      // installs so their initial render reflects any name/status/avatar
      // the renderer publishes during bootstrap rather than briefly
      // showing the bundled fallbacks.
      installAvatarIpc();
      installIdentityIpc();
      installPowerEvents();
      installStatusIpc();
      const retryProbe = installConnectivityProbe();
      installConnectivityIpc(retryProbe);

      // The toast factory: the classic shells' helper identity resolves to
      // a supervised sidecar client where the binary ships; macOS passes
      // its own native factory. An explicit `notifications.create` wins.
      const helperPath = inputs.helperToastExecutable
        ? resolveHelperToastBinaryPath({
            executable: inputs.helperToastExecutable,
            overrideEnvVar:
              inputs.helperToastOverrideEnvVar ?? "CADET_HELPER_TOAST_PATH",
          })
        : null;
      configureNotifications({
        ensureVisible: ensureMainWindow,
        logger: log,
        ...(helperPath
          ? {
              create: createHelperToastFactory({
                helperPath,
                name: inputs.helperToastName ?? "cadet-helper",
              }),
            }
          : {}),
        ...(inputs.notifications ?? {}),
      });

      // The instance that lost the single-instance lock is already
      // quitting. `app.quit()` requests a shutdown rather than halting the
      // module, and a `ready` that is already queued still fires, so the
      // losing instance gates everything below here. Electron's documented
      // single-instance example puts every `whenReady` side effect behind
      // this same branch.
      if (!hasInstanceLock) {
        return;
      }

      provisionPackagedCli();

      // The universal app surface — the installs all three shells ran
      // identically. Order matters where features read each other's
      // registrations (the host-proxy bridge defers one microtask so the
      // presence module's initial read lands first).
      installBundles();
      installHotkeysIpc();
      // The About window renders the app bundle's root on macOS (its dev
      // builds pack the renderer dists) and the web mount on the classic
      // shells, whose dev builds serve it from the dev server.
      configureAboutRuntime({
        rendererBase: () =>
          process.platform === "darwin"
            ? APP_RENDERER_BASE_PROD
            : getRendererBase(rendererUsesAppProtocol()),
        getAssistantName: getName,
        onAssistantNameChange: onNameChange,
      });
      installAbout();
      installDesktopMenu();
      installGlobalShortcuts({
        handlers: {
          globalHotkey: () => {
            void ensureMainWindow();
          },
          // Registered through installGlobalShortcuts so the Keyboard
          // Shortcuts rebinding applies and the chord is bound exactly once.
          quickInput: toggleQuickInput,
          // Talk, from wherever the user is. `registerAll` skips a command
          // with no handler — and macOS registers none: the voice key's
          // double tap is the keyboard way into a call there.
          ...(process.platform === "darwin"
            ? {}
            : {
                toggleVoice: () => {
                  if (current() !== null) {
                    dispatchToMain({ kind: "toggleVoice" });
                    return;
                  }
                  // No renderer to act in. Building one necessarily shows
                  // it, which is still better than a press that lands
                  // nowhere.
                  void ensureMainWindow().then(() => {
                    dispatchToMain({ kind: "toggleVoice" });
                  });
                },
              }),
        },
        logger: log,
      });
      installDiagnostics();
      installDownloads();
      installCommandPaletteWindow();
      installQuickInput();
      installPopoutWindows();
      installWindowAttentionFeature();

      // The classic-desktop composition: the features that are genuinely
      // classic-desktop-only. The macOS shell carries its own twins (the
      // share sheet, the tray with its companion rows, the companion
      // permissions) or ships none of it (no helper dictation bridge —
      // the native helper client has no darwin path), and installs them in
      // its own setup.
      if (process.platform !== "darwin") {
        installAuth();
        installAuxiliaryWindows();
        installLoginItem();
        installDictation();
        installHostProxy();
        installMainWindow();
        installPermissions();
        installTray();
        installShare();
        installVoiceModeChord();
      }

      await inputs.setup?.();
    })
    .catch((err: unknown) => {
      log.error("[app] whenReady setup failed:", err);
    });
};
