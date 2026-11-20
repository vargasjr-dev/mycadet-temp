import { app, session, shell, type Event } from "electron";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@mycadet/electron-desktop/capability-registry";
import {
  resolveAuthCallbackScheme,
  configureNativeAuth,
  installNativeAuth,
} from "@mycadet/electron-desktop";
import {
  clearSessionToken,
  getSessionToken,
  saveSessionToken,
  setSessionTokenLogger,
} from "@mycadet/electron-desktop/session-token-store";
import {
  resolveLocalConfigFromEnv,
} from "@mycadet/local-mode";

import { startWindowsAuthCallback } from "../auth-callback";
import { handle, handleSync } from "../ipc.client";
import { log } from "@mycadet/electron-desktop";
import { ensureVisible } from "../main-window";

const subscribeToAuthCallback = (
  listener: (url: string) => void,
): (() => void) => {
  const onSecondInstance = (_event: Event, argv: string[]): void => {
    for (const arg of argv) {
      listener(arg);
    }
  };
  const onOpenUrl = (event: Event, url: string): void => {
    event.preventDefault();
    listener(url);
  };

  app.on("second-instance", onSecondInstance);
  app.on("open-url", onOpenUrl);
  return () => {
    app.off("second-instance", onSecondInstance);
    app.off("open-url", onOpenUrl);
  };
};

const authFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "native-auth",
  install: () => {
    const authScheme = resolveAuthCallbackScheme();
    setSessionTokenLogger(log);
    configureNativeAuth({
      activateWindow: () => {
        app.focus({ steal: true });
        ensureVisible();
      },
      getCloudUrl: () => resolveLocalConfigFromEnv().cloudUrl,
      ipc: { handle, handleSync },
      openExternal: (url) => shell.openExternal(url),
      removeCookie: (url, name) =>
        session.defaultSession.cookies.remove(url, name),
      ...(app.isPackaged
        ? {
            startCallback: (expectedState: string) =>
              startWindowsAuthCallback(expectedState, {
                scheme: authScheme,
                subscribe: subscribeToAuthCallback,
              }),
          }
        : {}),
      sessionStore: {
        clear: clearSessionToken,
        get: getSessionToken,
        save: saveSessionToken,
      },
    });
    installNativeAuth();
  },
};

export default authFeature;
