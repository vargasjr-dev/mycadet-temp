import { app, powerMonitor } from "electron";
import fs from "node:fs/promises";
import os from "node:os";

import { installDiagnosticsIpc as installSharedDiagnosticsIpc } from "@mycadet/electron-desktop/diagnostics";
import { configureFeedback } from "@mycadet/electron-desktop/feedback";
import { writeSetting as writeSharedSetting } from "@mycadet/electron-desktop/settings";
import { getVersionInfo } from "@mycadet/electron-desktop/about";
import { handle, on } from "./ipc";
import { getLogFilePaths } from "@mycadet/electron-desktop/app-logger";
import { getSessionToken } from "@mycadet/electron-desktop/session-token-store";

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
