import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

import { configureCliPaths } from "@mycadet/local-mode";

import {
  ensureCliInstalled,
  getBundledBunPath,
  getCliBinPath,
} from "./cli-installer";

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
