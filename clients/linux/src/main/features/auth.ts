import { app, session, shell, type Event } from "electron";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@mycadet/electron-desktop/capability-registry";
import { resolveAuthCallbackScheme } from "@mycadet/electron-desktop/deep-links";
import {
  configureNativeAuth,
  installNativeAuth,
} from "@mycadet/electron-desktop/native-auth";
import {
  clearSessionToken,
  getSessionToken,
  saveSessionToken,
  setSessionTokenLogger,
} from "@mycadet/electron-desktop/session-token-store";
import {
  resolveEnvironmentName,
  resolveLocalConfigFromEnv,
} from "@mycadet/local-mode";

import { startLinuxAuthCallback } from "../auth-callback";
import { handle, handleSync } from "../ipc.client";
import log from "../logger";
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
    const authScheme = resolveAuthCallbackScheme(
      resolveEnvironmentName(),
    );
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
              startLinuxAuthCallback(expectedState, {
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
