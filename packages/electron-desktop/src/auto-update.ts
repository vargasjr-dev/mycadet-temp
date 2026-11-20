import { app, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { z } from "zod";

import log from "./app-logger";
import { resolveEnvironmentName } from "@mycadet/shared";
import type { UpdateState, UpdateStatus } from "@mycadet/ipc-contract";

import type { UpdateFeedPlatform } from "./auto-update-contract";
import type { IpcHandle } from "./ipc";

export type { UpdateState, UpdateStatus };
export type { UpdateFeedPlatform } from "./auto-update-contract";

/**
 * Platform- and architecture-isolated generic feed URL for this build's
 * release channel (`resolveEnvironmentName`, which every client seeds from
 * the same baked define the packaged build ships with).
 */
export const resolveUpdateFeedUrl = (
  platform: UpdateFeedPlatform,
  arch: string,
): string => {
  const environment = resolveEnvironmentName();
  const bucketEnv = environment === "production" ? "prod" : environment;
  return `https://storage.googleapis.com/mycadet-${bucketEnv}-releases/${platform}/${arch}/`;
};

export interface AutoUpdateOptions {
  ipc: { handle: IpcHandle };
  /** The updater feed's platform bucket, e.g. `linux-electron`. */
  platform: UpdateFeedPlatform;
}

let currentState: UpdateState = { status: "idle" };

const setState = (next: UpdateState): void => {
  currentState = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("cadet:update:state", currentState);
    }
  }
};

export const checkForUpdates = (): void => {
  autoUpdater
    .checkForUpdates()
    .then((result) => {
      // With `autoDownload`, electron-updater returns the in-flight download
      // on the resolved result and rethrows download failures on it after
      // emitting `error`. The `error` listener owns state and logging, so this
      // only keeps the rejection from escaping.
      result?.downloadPromise?.catch(() => undefined);
    })
    .catch((err: unknown) => {
      log.error("[auto-update] checkForUpdates failed:", err);
    });
};

/** Installs the updater, its IPC surface, and the periodic check. */
export const installAutoUpdate = ({
  ipc,
  platform,
}: AutoUpdateOptions): void => {
  const { handle } = ipc;
  handle("cadet:update:getState", z.tuple([]), () => currentState);
  handle("cadet:update:check", z.tuple([]), () => checkForUpdates());
  handle("cadet:update:install", z.tuple([]), () =>
    autoUpdater.quitAndInstall(),
  );

  if (!app.isPackaged) return;

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.channel = resolveEnvironmentName();
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: resolveUpdateFeedUrl(platform, process.arch),
  });

  autoUpdater.on("checking-for-update", () => {
    setState({ status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    setState({ status: "available", version: info.version });
  });

  autoUpdater.on("download-progress", (progressObj) => {
    setState({
      status: "downloading",
      progress: {
        percent: progressObj.percent,
        transferred: progressObj.transferred,
        total: progressObj.total,
      },
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setState({ status: "downloaded", version: info.version });
  });

  autoUpdater.on("error", (err) => {
    log.error("[auto-update] error:", err);
    setState({ status: "error", error: err.message });
  });

  autoUpdater.on("update-not-available", () => {
    setState({ status: "idle" });
  });

  checkForUpdates();
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
};
