import { app, powerMonitor } from "electron";
import fs from "node:fs/promises";
import os from "node:os";

import { installDiagnosticsIpc as installSharedDiagnosticsIpc } from "@mycadet/electron-desktop/diagnostics";
import {
  configureFeedback,
  installFeedbackIpc,
} from "@mycadet/electron-desktop/feedback";
import { writeSetting as writeSharedSetting } from "@mycadet/electron-desktop/settings";
import { readSetting, writeSetting } from "@mycadet/electron-desktop/settings";

import { getVersionInfo } from "./about.client";
import { getInstallLocation } from "./install-location";
import { handle, on } from "./ipc";
import { getLogFilePaths } from "./logger";
import { getSessionToken } from "./session-token-store.client";

declare const __CADET_ENVIRONMENT__: string;

const releaseChannel =
  typeof __CADET_ENVIRONMENT__ === "string"
    ? __CADET_ENVIRONMENT__
    : "production";

configureFeedback({
  ipc: { handle },
  app,
  powerMonitor,
  os,
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  getVersionInfo: () => ({ ...getVersionInfo(), releaseChannel }),
  getLogFilePaths,
  hasSession: () => getSessionToken() !== null,
});

export const installDiagnosticsIpc = (): void => {
  // Persist the renderer's effective diagnostics consent. Sentry reporting
  // is gone; this keeps the user's choice durable for the settings surface.
  installSharedDiagnosticsIpc({ on }, (enabled) =>
    writeSharedSetting("shareDiagnostics", enabled),
  );
};

export { installFeedbackIpc };
