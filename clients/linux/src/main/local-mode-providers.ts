import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

import type { DesktopCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import {
  LOCAL_MODE_CLI,
  LOCAL_MODE_PATHS,
  LOCAL_MODE_SESSION,
} from "@mycadet/electron-desktop/local-mode";
import { getSessionToken } from "@mycadet/electron-desktop/session-token-store";
import {
  resolveConfigDir,
  resolveEnvironmentName,
  resolveLockfilePaths,
  type CliInvocation,
} from "@mycadet/local-mode";

import {
  ensureCliInstalled,
  getBundledBunPath,
  getCliBinPath,
} from "./cli-installer";

const resolveCliInvocation = async (): Promise<CliInvocation> => {
  const override = process.env.CADET_CLI_PATH;
  if (override) {
    return { command: "bun", baseArgs: ["run", override] };
  }

  if (!app.isPackaged) {
    const repoRoot = path.resolve(app.getAppPath(), "..", "..");
    const cliEntry = path.join(repoRoot, "cli", "src", "index.ts");
    if (existsSync(cliEntry)) {
      return { command: "bun", baseArgs: ["run", cliEntry] };
    }
  }

  await ensureCliInstalled();
  return { command: getBundledBunPath(), baseArgs: ["run", getCliBinPath()] };
};

export const installLinuxLocalModeProviders = (
  registry: DesktopCapabilityRegistry,
): void => {
  registry.provide(LOCAL_MODE_CLI, { resolveInvocation: resolveCliInvocation });
  registry.provide(LOCAL_MODE_PATHS, {
    configDir: resolveConfigDir(process.env),
    environment: resolveEnvironmentName(),
    lockfilePaths: resolveLockfilePaths(process.env),
  });
  registry.provide(LOCAL_MODE_SESSION, { getToken: getSessionToken });
};
