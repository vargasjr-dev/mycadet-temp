import { app, protocol, session, shell } from "electron";
import path from "node:path";
import type { MainLogger } from "electron-log";

import { resolveEnvironmentName } from "@mycadet/shared";

import { getAppName } from "./app-name";
import { APP_HOST, APP_PROTOCOL, usesAppProtocolRenderer } from "./app-config";
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
import { installIdentityIpc } from "./identity";
import { installPowerEvents } from "./power-events";
import { installConnectivityIpc, installStatusIpc } from "./status";
import { installConnectivityProbe } from "./connectivity-probe";
import {
  configureNotifications,
  type NotificationCreateOptions,
  type NotificationLike,
} from "./notifications";
import { installUniversalFeatures } from "./universal-wiring";

/**
 * The client's own pieces of the lifecycle — the seams that genuinely
 * differ per desktop: which window `ensureVisible` restores, how launch
 * argv arrive, whether the renderer rides `app://` in dev, the toast
 * factory notifications deliver through, the packaged CLI provisioning,
 * and the environment name (macOS bakes it as a build define).
 */
export interface DesktopAppInputs {
  /** Bring the client's main window to front; each shell owns its own. */
  ensureVisible: () => void | Promise<void>;
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
  /** The packaged CLI provisioning step (the wrapper or launcher family). */
  provisionCli?: () => void;
  /**
   * The environment name the userData suffix derives from. Defaults to
   * `resolveEnvironmentName()`; macOS passes its baked build define.
   */
  environmentName?: string;
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
 *   (presence runtime, avatar, identity, power, status, connectivity —
 *   registered before any window or tray exists so their initial render
 *   reflects what the renderer publishes during bootstrap), and the
 *   notification runtime;
 * - then the client's own setup, skipped entirely on the lock loser.
 */
export const startApp = (
  log: MainLogger,
  setup: () => void | Promise<void>,
  inputs: DesktopAppInputs,
): void => {
  // Single-instance lock: relaunches focus the existing window instead of
  // spawning a parallel main process. The second-instance handler fires on
  // the instance that holds the lock (the primary).
  // https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata
  const hasInstanceLock = app.requestSingleInstanceLock();
  if (!hasInstanceLock) {
    app.quit();
  }

  applyUserDataSuffix(inputs.environmentName ?? resolveEnvironmentName());
  registerPrivilegedSchemes();

  // Deep-link plumbing — registered before `whenReady` so the
  // `will-finish-launching` subscription captures URLs delivered AT
  // launch (the OS opens the app via a `cadet://` click → `open-url`
  // can fire before `whenReady`). Registering in `whenReady` misses
  // the launching URL — the #1 deep-link bug in Electron apps.
  configureDeepLinks({
    ensureVisible: inputs.ensureVisible,
    initialArgv: inputs.initialArgv ?? process.argv,
  });
  installDeepLinks();
  configureFileOpen({ ensureMainWindowVisible: inputs.ensureVisible });
  installFileOpen();
  // Cold-launch argv: files the OS handed the first instance before the
  // handlers existed. macOS reads `open-file` events instead, so its input
  // is empty and this is a no-op.
  handleFileOpenArgv(inputs.initialArgv ?? process.argv);

  // Feature modules each attach cleanup listeners; lift the default cap of
  // 10 so they don't trip MaxListenersExceededWarning. The security wiring
  // rides every WebContents the process ever creates (main window, popouts,
  // command palette, child popups), so it is subscribed before any window
  // exists.
  app.on("web-contents-created", (_event, contents) => {
    contents.setMaxListeners(20);
    installWebContentsSecurity(contents, {
      cookies: () => session.defaultSession.cookies,
      logger: log,
      openExternal: (url) => shell.openExternal(url),
    });
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

      configureNotifications({
        ensureVisible: inputs.ensureVisible,
        logger: log,
        ...(inputs.notifications ?? {}),
      });

      // The instance that lost the single-instance lock is already
      // quitting. `app.quit()` requests a shutdown rather than halting the
      // module, and a `ready` that is already queued still fires, so the
      // losing instance gates its own setup here. Electron's documented
      // single-instance example puts every `whenReady` side effect behind
      // this same branch.
      if (!hasInstanceLock) {
        return;
      }

      inputs.provisionCli?.();
      await setup();
    })
    .catch((err: unknown) => {
      log.error("[app] whenReady setup failed:", err);
    });
};
