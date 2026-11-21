import { app } from "electron";
import type { MainLogger } from "electron-log";

import { getAppName } from "./app-name";
import { installUniversalFeatures } from "./universal-wiring";

/**
 * The app-lifecycle seam every desktop client shares. Owns the wiring that
 * is identical across the three shells — the app name, the hotkey settings
 * (the settings-store provider all three shipped identically), and the
 * auto-update install (the same call modulo a platform bucket this process
 * derives itself) — then hands the client its own setup once Electron is
 * ready.
 */
export const startApp = (
  log: MainLogger,
  setup: () => void | Promise<void>,
): void => {
  app.setName(getAppName());
  void app
    .whenReady()
    .then(async () => {
      log.info("[app] ready");
      installUniversalFeatures();
      await setup();
    })
    .catch((err: unknown) => {
      log.error("[app] whenReady setup failed:", err);
    });
};
