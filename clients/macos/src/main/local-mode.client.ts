import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  configureLocalMode,
  installLocalMode,
} from "@mycadet/electron-desktop/local-mode";
import { configureCliPaths, resolveCliInvocation } from "@mycadet/local-mode";

import {
  ensureCliInstalled,
  getBundledBunPath,
  getCliBinPath,
} from "./cli-installer";
import { handle } from "./ipc";
import { refreshLockfileNow } from "@mycadet/electron-desktop/lockfile-watcher";
import { getSessionToken } from "./session-token-store.client";

// The CLI-invocation resolution is inlined into @mycadet/local-mode; the
// host's part is only its own facts: the bundled bun + installed CLI pair
// (probed after the installer runs) and the dev checkout behind the
// packaging check.
configureCliPaths({
  installed: () => [{ bun: getBundledBunPath(), cli: getCliBinPath() }],
  devEntry: () => {
    if (app.isPackaged) return undefined;
    const repoRoot = path.resolve(app.getAppPath(), "..", "..");
    const cliEntry = path.join(repoRoot, "cli", "src", "index.ts");
    return existsSync(cliEntry) ? cliEntry : undefined;
  },
  prepare: ensureCliInstalled,
});

export { resolveCliInvocation };

configureLocalMode({
  handle,
  refreshLockfile: refreshLockfileNow,
  session: { getToken: getSessionToken },
});
