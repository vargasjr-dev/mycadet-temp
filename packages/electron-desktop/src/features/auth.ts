import { app, session, shell, type Event } from "electron";

import { configureNativeAuth, installNativeAuth } from "../native-auth";
import { resolveAuthCallbackScheme } from "../deep-links";
import {
  clearSessionToken,
  getSessionToken,
  saveSessionToken,
  setSessionTokenLogger,
} from "../session-token-store";
import { resolveLocalConfigFromEnv } from "@mycadet/local-mode";

import { startAuthCallback } from "../auth-callback";
import { handle, handleSync } from "../ipc";
import log from "../app-logger";
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

export const install = (): void => {
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
            startAuthCallback(expectedState, {
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
};
