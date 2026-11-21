import { app, powerMonitor } from "electron";
import fs from "node:fs/promises";
import os from "node:os";

import { installDiagnosticsIpc } from "../diagnostics";
import {
  configureFeedback,
  installFeedbackIpc,
  type FeedbackDependencies,
} from "../feedback";
import { writeSetting as writeSharedSetting } from "../settings";
import { getSessionToken } from "../session-token-store";
import { resolveEnvironmentName } from "@mycadet/shared";

import { getLogFilePaths } from "../app-logger";

declare const __CADET_BUILD_SHA__: string;
const commitSha =
  typeof __CADET_BUILD_SHA__ === "string" ? __CADET_BUILD_SHA__ : "unknown";
const releaseChannel = resolveEnvironmentName();

const feedback: FeedbackDependencies = {
  app,
  powerMonitor,
  os,
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  getVersionInfo: () => ({
    appName: app.getName(),
    version: app.getVersion(),
    commitSha,
    releaseChannel,
  }),
  getLogFilePaths,
  hasSession: () => getSessionToken() !== null,
};

configureFeedback(feedback);

export const install = (): void => {
  // Persist the renderer's effective diagnostics consent. Sentry reporting
  // is gone; this keeps the user's choice durable for the settings surface.
  installDiagnosticsIpc((enabled) =>
    writeSharedSetting("shareDiagnostics", enabled),
  );
  installFeedbackIpc();
};
