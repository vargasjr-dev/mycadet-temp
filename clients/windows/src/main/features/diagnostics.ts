import { app, powerMonitor } from "electron";
import fs from "node:fs/promises";
import os from "node:os";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { installDiagnosticsIpc } from "@vellumai/electron-desktop/diagnostics";
import { installFeatureFlagsIpc } from "@vellumai/electron-desktop/feature-flags";
import {
  configureFeedback,
  installFeedbackIpc,
  type FeedbackDependencies,
} from "@vellumai/electron-desktop/feedback";
import { installFeedbackIpc, type FeedbackDependencies } from "@vellumai/electron-desktop/feedback";
import { writeSetting as writeSharedSetting } from "@vellumai/electron-desktop/settings";
import { getSessionToken } from "@vellumai/electron-desktop/session-token-store";
import {
  readSetting,
  writeSetting,
} from "@vellumai/electron-desktop/settings";

import { WINDOWS_RELEASE_INFO } from "../app-config";
import { handle, on } from "../ipc.client";
import { getLogFilePaths } from "../logger";

const { commitSha, releaseChannel } = WINDOWS_RELEASE_INFO;

const feedback: FeedbackDependencies = {
  ipc: { handle },
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
  getFeatureFlags: () => readSetting("featureFlags"),
  hasSession: () => getSessionToken() !== null,
};

configureFeedback(feedback);

const diagnosticsFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "diagnostics",
  install: () => {
    installFeatureFlagsIpc(
      { on },
      { write: (flags) => writeSetting("featureFlags", flags) },
    );
    // Persist the renderer's effective diagnostics consent. Sentry reporting
    // is gone; this keeps the user's choice durable for the settings surface.
    installDiagnosticsIpc(
      { on },
      (enabled) => writeSharedSetting("shareDiagnostics", enabled),
    );
    installFeedbackIpc();
  },
};

export default diagnosticsFeature;
