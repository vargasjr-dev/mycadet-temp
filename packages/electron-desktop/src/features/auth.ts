import { app, type Event } from "electron";

import { configureNativeAuth, installNativeAuth } from "../native-auth";
import { resolveAuthCallbackScheme } from "../deep-links";

import { startAuthCallback } from "../auth-callback";
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
  configureNativeAuth({
    activateWindow: () => {
      app.focus({ steal: true });
      ensureVisible();
    },
    ...(app.isPackaged
      ? {
          startCallback: (expectedState: string) =>
            startAuthCallback(expectedState, {
              scheme: authScheme,
              subscribe: subscribeToAuthCallback,
            }),
        }
      : {}),
  });
  installNativeAuth();
};
