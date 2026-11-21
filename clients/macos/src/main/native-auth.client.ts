import { app, session, shell } from "electron";

import { configureNativeAuth } from "@mycadet/electron-desktop";
import { resolveLocalConfigFromEnv } from "@mycadet/local-mode";

import { ensureVisible } from "./main-window";
import {
  clearSessionToken,
  getSessionToken,
  saveSessionToken,
} from "@mycadet/electron-desktop/session-token-store";

configureNativeAuth({
  activateWindow: () => {
    app.focus({ steal: true });
    ensureVisible();
  },
  getCloudUrl: () => resolveLocalConfigFromEnv().cloudUrl,
  openExternal: (url) => shell.openExternal(url),
  removeCookie: (url, name) => session.defaultSession.cookies.remove(url, name),
  sessionStore: {
    clear: clearSessionToken,
    get: getSessionToken,
    save: saveSessionToken,
  },
});
