import { app, powerMonitor } from "electron";
import fs from "node:fs/promises";
import os from "node:os";

import { installDiagnosticsIpc as installSharedDiagnosticsIpc } from "@vellumai/electron-desktop/diagnostics";
import { installFeatureFlagsIpc as installSharedFeatureFlagsIpc } from "@vellumai/electron-desktop/feature-flags";
import {
  configureFeedback,
  installFeedbackIpc,
} from "@vellumai/electron-desktop/feedback";
import { writeSetting as writeSharedSetting } from "@vellumai/electron-desktop/settings";
import {
  readSetting,
  writeSetting,
} from "@vellumai/electron-desktop/settings";

import { getVersionInfo } from "./about.client";
import { getInstallLocation } from "./install-location";
import { handle, on } from "./ipc";
import { getLogFilePaths } from "./logger";
import { getSessionToken } from "./session-token-store.client";

declare const __VELLUM_ENVIRONMENT__: string;

const releaseChannel =
  typeof __VELLUM_ENVIRONMENT__ === "string"
    ? __VELLUM_ENVIRONMENT__
    : "production";

configureFeedback({
  ipc: { handle },
  app,
  powerMonitor,
  os,
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  getVersionInfo: () => ({ ...getVersionInfo(), releaseChannel }),
  getLogFilePaths,
  getFeatureFlags: () => readSetting("featureFlags"),
  hasSession: () => getSessionToken() !== null,
});

export const installFeatureFlagsIpc = (): void => {
  installSharedFeatureFlagsIpc(
    { on },
    { write: (flags) => writeSetting("featureFlags", flags) },
  );
};

export const installDiagnosticsIpc = (): void => {
  // Persist the renderer's effective diagnostics consent. Sentry reporting
  // is gone; this keeps the user's choice durable for the settings surface.
  installSharedDiagnosticsIpc(
    { on },
    (enabled) => writeSharedSetting("shareDiagnostics", enabled),
  );
};

export { installFeedbackIpc };
