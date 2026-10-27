import { app } from "electron";
import path from "node:path";

import type { DesktopCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import { LOCAL_MODE_CLI, LOCAL_MODE_SESSION } from "@mycadet/electron-desktop/local-mode";
import { getSessionToken } from "@mycadet/electron-desktop/session-token-store";
import {
  resolveDevCliInvocation,
  type CliInvocation,
} from "@mycadet/local-mode";

import { provisionCliRuntime, resolveCliRuntimePaths } from "./cli-installer";

const resolveCliInvocation = async (): Promise<CliInvocation> => {
  const override = process.env.CADET_CLI_PATH;
  if (override) {
    return { command: "bun", baseArgs: ["run", override] };
  }

  if (!app.isPackaged) {
    const repoRoot = path.resolve(app.getAppPath(), "..", "..");
    try {
      return resolveDevCliInvocation(repoRoot, import.meta.url);
    } catch {
      // Fall through to the packaged runtime.
    }
  }

  const runtime = provisionCliRuntime(
    resolveCliRuntimePaths(
      app.getPath("userData"),
      process.resourcesPath,
      app.getVersion(),
    ),
  );
  return {
    command: path.join(runtime.installDir, "cadet.exe"),
    baseArgs: [],
  };
};

export const installWindowsLocalModeProviders = (
  registry: DesktopCapabilityRegistry,
): void => {
  registry.provide(LOCAL_MODE_CLI, { resolveInvocation: resolveCliInvocation });
  registry.provide(LOCAL_MODE_SESSION, { getToken: getSessionToken });
};
