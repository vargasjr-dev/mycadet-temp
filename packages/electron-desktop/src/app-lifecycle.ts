import { app } from "electron";
import type { MainLogger } from "electron-log";

import { getAppName } from "./app-name";

/**
 * The app-lifecycle seam every desktop client shares.
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
      await setup();
    })
    .catch((err: unknown) => {
      log.error("[app] whenReady setup failed:", err);
    });
};
