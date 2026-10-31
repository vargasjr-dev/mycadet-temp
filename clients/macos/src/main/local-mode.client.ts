import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  configureLocalMode,
  installLocalMode,
} from "@mycadet/electron-desktop/local-mode";
import { type CliInvocation } from "@mycadet/local-mode";

import {
  ensureCliInstalled,
  getBundledBunPath,
  getCliBinPath,
} from "./cli-installer";
import { handle } from "./ipc";
import { refreshLockfileNow } from "@mycadet/electron-desktop/lockfile-watcher";
import { getSessionToken } from "./session-token-store.client";

export const resolveCliInvocation = async (): Promise<CliInvocation> => {
  const envPath = process.env.CADET_CLI_PATH;
  if (envPath) {
    return { command: "bun", baseArgs: ["run", envPath] };
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

configureLocalMode({
  cli: { resolveInvocation: resolveCliInvocation },
  handle,
  refreshLockfile: refreshLockfileNow,
  session: { getToken: getSessionToken },
});
