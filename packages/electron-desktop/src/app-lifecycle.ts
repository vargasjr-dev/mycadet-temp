import { resolveEnvironmentName } from "@mycadet/shared";
import { app } from "electron";
import type { MainLogger } from "electron-log";

export const getAppName = () => {
  const envName = resolveEnvironmentName();
  if (envName === "production") {
    return "Cadet";
  } else {
    return `Cadet ${envName.slice(0, 1).toUpperCase()}${envName.slice(1)}`;
  }
};

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
